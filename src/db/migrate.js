import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', '..', 'db', 'migrations');
const LOCK_KEY = 727_274; // arbitrary constant for pg_advisory_lock

async function readMigrationFiles(dir = MIGRATIONS_DIR) {
  const names = (await readdir(dir)).filter((n) => /^\d+_.+\.sql$/.test(n)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function withClient(databaseUrl, ssl, fn) {
  const client = new pg.Client({ connectionString: databaseUrl, ssl, application_name: 'dynamic-barcode-migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        VARCHAR(255) PRIMARY KEY,
      checksum    VARCHAR(64)  NOT NULL,
      applied_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
    )`);
}

/** Applies all pending migrations in order. Returns the names that were applied. */
export async function migrateUp({ databaseUrl, ssl = false, dir, log = () => {} }) {
  const files = await readMigrationFiles(dir);
  return withClient(databaseUrl, ssl, async (client) => {
    await ensureTable(client);
    const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    const done = [];

    for (const file of files) {
      if (applied.has(file.name)) {
        if (applied.get(file.name) !== file.checksum) {
          log(`PERINGATAN: ${file.name} sudah dijalankan tetapi isinya berubah. Buat migration baru, jangan ubah yang lama.`);
        }
        continue;
      }
      log(`Menjalankan ${file.name} ...`);
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `Migration ${file.name} gagal: ${err.message}`;
        throw err;
      }
      done.push(file.name);
    }
    return done;
  });
}

/** Lists every migration file with its applied state. */
export async function migrationStatus({ databaseUrl, ssl = false, dir }) {
  const files = await readMigrationFiles(dir);
  return withClient(databaseUrl, ssl, async (client) => {
    await ensureTable(client);
    const { rows } = await client.query('SELECT name, applied_at FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.applied_at]));
    return files.map((f) => ({ name: f.name, appliedAt: applied.get(f.name) ?? null }));
  });
}

/**
 * DEV ONLY: drops every table and sequence in the current schema, then re-applies all migrations.
 * Callers must guard against running this in production.
 */
export async function migrateFresh({ databaseUrl, ssl = false, dir, log = () => {} }) {
  await withClient(databaseUrl, ssl, async (client) => {
    await client.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = current_schema()) LOOP
          EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', current_schema(), r.tablename);
        END LOOP;
        FOR r IN (SELECT sequencename FROM pg_sequences WHERE schemaname = current_schema()) LOOP
          EXECUTE format('DROP SEQUENCE IF EXISTS %I.%I CASCADE', current_schema(), r.sequencename);
        END LOOP;
      END
      $$;`);
    log('Semua tabel dihapus.');
  });
  return migrateUp({ databaseUrl, ssl, dir, log });
}
