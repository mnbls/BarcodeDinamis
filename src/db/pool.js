import pg from 'pg';

// BIGINT (int8) -> JS number. Counters/ids stay far below 2^53.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// DATE -> 'YYYY-MM-DD' string (avoid accidental timezone shifting of calendar dates).
pg.types.setTypeParser(1082, (v) => v);

/** Wraps a pg Pool or PoolClient with small promise helpers. */
function bind(runner) {
  return {
    /** Raw pg result (rows, rowCount, ...). */
    query: (text, params) => runner.query(text, params),
    /** All rows. */
    rows: async (text, params) => (await runner.query(text, params)).rows,
    /** First row or null. */
    one: async (text, params) => (await runner.query(text, params)).rows[0] ?? null,
  };
}

/**
 * Creates the database handle used across the app:
 *   db.query / db.rows / db.one          -> run on the pool
 *   db.tx(async (tx) => { ... })         -> same helpers, inside one transaction
 */
export function createDb(config, logger) {
  const pool = new pg.Pool({
    connectionString: config.db.url,
    ssl: config.db.ssl,
    max: config.db.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: config.db.statementTimeoutMs || undefined,
    application_name: 'dynamic-barcode',
  });

  pool.on('error', (err) => {
    // Idle client errors (e.g. server restart) must not crash the process.
    logger?.error({ err }, 'pg pool error');
  });

  const base = bind(pool);

  return {
    ...base,
    pool,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(bind(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection is already broken; the original error matters more */
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async ping() {
      await pool.query('SELECT 1');
      return true;
    },
    async end() {
      await pool.end();
    },
  };
}

/** PostgreSQL error helpers. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FK_VIOLATION: '23503',
  DEADLOCK: '40P01',
  SERIALIZATION: '40001',
};

export function isPgError(err, code) {
  return Boolean(err) && err.code === code;
}
