import { allocateCodes } from '../../lib/codes.js';
import { generateEditToken } from '../../lib/edit-token.js';
import { escapeLike } from '../../lib/text.js';

// Effective state, in the same order the redirect endpoint checks: inactive wins over expired, and a
// barcode that is active and valid but has no destination yet is "pending" (Belum diisi).
export const STATE_SQL = `(CASE
  WHEN b.status = 'inactive' THEN 'inactive'
  WHEN b.expired_at IS NOT NULL AND b.expired_at <= now() THEN 'expired'
  WHEN b.target_url IS NULL THEN 'pending'
  ELSE 'active' END)`;

// "Valid" = switched on and not past its expiry. Both the active and the pending filters build on it.
const VALID_SQL = `(b.status = 'active' AND (b.expired_at IS NULL OR b.expired_at > now()))`;

const COLUMNS = `b.id, b.code, b.name, b.description, b.target_type, b.target_url, b.status,
  b.expired_at, b.scan_count, b.last_scanned_at, b.import_batch_id, b.created_by,
  b.created_at, b.updated_at, ${STATE_SQL} AS state`;

/** Whitelist: user-supplied sort keys never reach the SQL text directly. */
export const SORTS = {
  code: 'b.code',
  name: 'lower(b.name)',
  status: 'state',
  scan_count: 'b.scan_count',
  created_at: 'b.created_at',
  updated_at: 'b.updated_at',
  expired_at: 'b.expired_at',
  last_scanned_at: 'b.last_scanned_at',
};

/**
 * Builds a parameterised WHERE clause shared by the list, export and bulk operations.
 * filters: { q, status, from, to, batch, ids }
 */
export function buildWhere(filters = {}, timezone, firstParam = 1) {
  const clauses = [];
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length + firstParam - 1}`;
  };
  let tzParam;
  const tz = () => (tzParam ??= add(timezone));

  if (filters.ids?.length) clauses.push(`b.id = ANY(${add(filters.ids)}::bigint[])`);

  if (filters.q) {
    const p = add(`%${escapeLike(filters.q)}%`);
    clauses.push(`(b.code ILIKE ${p} OR b.name ILIKE ${p} OR b.target_url ILIKE ${p})`);
  }

  if (filters.status === 'active') clauses.push(`(${VALID_SQL} AND b.target_url IS NOT NULL)`);
  else if (filters.status === 'pending') clauses.push(`(${VALID_SQL} AND b.target_url IS NULL)`);
  else if (filters.status === 'inactive') clauses.push(`b.status = 'inactive'`);
  else if (filters.status === 'expired') clauses.push(`(b.status = 'active' AND b.expired_at IS NOT NULL AND b.expired_at <= now())`);

  if (filters.from) clauses.push(`b.created_at >= (${add(filters.from)}::date)::timestamp AT TIME ZONE ${tz()}`);
  if (filters.to) clauses.push(`b.created_at < ((${add(filters.to)}::date + 1)::timestamp AT TIME ZONE ${tz()})`);
  if (filters.batch) clauses.push(`b.import_batch_id = ${add(filters.batch)}::bigint`);

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export async function list(db, { filters, sort = 'created_at', dir = 'desc', page = 1, perPage = 25 }, timezone) {
  const { where, params } = buildWhere(filters, timezone);
  const orderExpr = Object.hasOwn(SORTS, sort) ? SORTS[sort] : SORTS.created_at;
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  const limitIdx = params.length + 1;

  const [rows, count] = await Promise.all([
    db.rows(
      `SELECT ${COLUMNS} FROM barcodes b ${where}
       ORDER BY ${orderExpr} ${direction} NULLS LAST, b.id DESC
       LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
      [...params, perPage, (page - 1) * perPage],
    ),
    db.one(`SELECT count(*)::bigint AS total FROM barcodes b ${where}`, params),
  ]);
  return { rows, total: count.total };
}

export function findByCode(db, code, { forUpdate = false } = {}) {
  return db.one(`SELECT ${COLUMNS} FROM barcodes b WHERE b.code = $1 ${forUpdate ? 'FOR UPDATE OF b' : ''}`, [code]);
}

export function findById(db, id) {
  return db.one(`SELECT ${COLUMNS} FROM barcodes b WHERE b.id = $1`, [id]);
}

/** Hot path of /b/{code}: one indexed lookup, only the columns that are needed. */
export function resolveForRedirect(db, code) {
  return db.one('SELECT id, code, target_url, status, expired_at FROM barcodes WHERE code = $1', [code]);
}

const INSERT_SQL = `
  INSERT INTO barcodes (code, name, description, target_type, target_url, status, expired_at, created_by, import_batch_id, edit_token)
  SELECT t.code, t.name, t.description, t.target_type, t.target_url, t.status,
         (t.expired_local::timestamp AT TIME ZONE $8), $9::bigint, $10::bigint, t.edit_token
  FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $11::text[])
       AS t(code, name, description, target_type, target_url, status, expired_local, edit_token)
  ON CONFLICT (code) DO NOTHING
  RETURNING id, code`;

/**
 * Inserts many barcodes with one statement (arrays + unnest, so parameter count does not grow with
 * the number of rows). Codes are allocated here. A code collision (only possible in random mode, or
 * if someone inserted a code by hand) is retried with fresh codes. Every new barcode also gets its own
 * edit-link secret; a row whose targetUrl is null is a barcode that is filled in later.
 * @returns {Promise<{id:number, code:string}[]>}
 */
export async function insertRows(db, config, rows, { createdBy = null, importBatchId = null } = {}) {
  let pending = rows;
  const inserted = [];

  for (let attempt = 0; attempt < 6 && pending.length > 0; attempt += 1) {
    const codes = await allocateCodes(db, config, pending.length);
    const res = await db.rows(INSERT_SQL, [
      codes,
      pending.map((r) => r.name),
      pending.map((r) => r.description ?? null),
      pending.map((r) => r.targetType),
      pending.map((r) => r.targetUrl ?? null),
      pending.map((r) => r.status),
      pending.map((r) => r.expiredLocal ?? null),
      config.timezone,
      createdBy,
      importBatchId,
      pending.map(() => generateEditToken()),
    ]);
    inserted.push(...res);
    const done = new Set(res.map((r) => r.code));
    pending = pending.filter((_, i) => !done.has(codes[i]));
  }
  if (pending.length > 0) throw new Error('Gagal membuat kode unik setelah beberapa percobaan.');
  return inserted;
}

export function update(db, id, values, { keepExpiry, timezone }) {
  return db.one(
    `UPDATE barcodes b SET
       name = $2, description = $3, target_type = $4, target_url = $5, status = $6,
       expired_at = CASE WHEN $7::boolean THEN b.expired_at ELSE ($8::text)::timestamp AT TIME ZONE $9 END,
       updated_at = now()
     WHERE b.id = $1
     RETURNING ${COLUMNS}`,
    [id, values.name, values.description, values.targetType, values.targetUrl, values.status, keepExpiry, values.expiredLocal, timezone],
  );
}

/* --------------------------- public edit link --------------------------- */

/** The barcode an edit link belongs to, or null (unknown, revoked or replaced link). */
export function findByEditToken(db, token, { forUpdate = false } = {}) {
  return db.one(`SELECT ${COLUMNS} FROM barcodes b WHERE b.edit_token = $1 ${forUpdate ? 'FOR UPDATE OF b' : ''}`, [token]);
}

/** The secret is kept out of COLUMNS on purpose: only code that really needs it (the admin's detail page) asks. */
export async function getEditToken(db, id) {
  const row = await db.one('SELECT edit_token FROM barcodes WHERE id = $1', [id]);
  return row?.edit_token ?? null;
}

/** Stores a new secret (replacing the old link) or null (revoking the link). Not a content change: updated_at stays. */
export async function setEditToken(db, code, token) {
  const res = await db.query('UPDATE barcodes SET edit_token = $2 WHERE code = $1', [code, token]);
  return res.rowCount;
}

/** The only thing a holder of the edit link may change. */
export function updateTarget(db, id, { targetType, targetUrl }) {
  return db.query('UPDATE barcodes SET target_type = $2, target_url = $3, updated_at = now() WHERE id = $1', [id, targetType, targetUrl]);
}

export async function setStatus(db, code, status) {
  const res = await db.query(
    `UPDATE barcodes SET status = $2, updated_at = now() WHERE code = $1 AND status <> $2`,
    [code, status],
  );
  return res.rowCount;
}

export async function deleteByCode(db, code) {
  const res = await db.query('DELETE FROM barcodes WHERE code = $1', [code]);
  return res.rowCount;
}

/** Bulk status change for the given filter/selection. Returns the number of rows changed. */
export async function bulkSetStatus(db, filters, status, timezone) {
  const { where, params } = buildWhere(filters, timezone);
  const statusIdx = params.length + 1;
  const guard = `b.status <> $${statusIdx}`;
  const res = await db.query(
    `UPDATE barcodes b SET status = $${statusIdx}, updated_at = now()
     ${where ? `${where} AND ${guard}` : `WHERE ${guard}`}`,
    [...params, status],
  );
  return res.rowCount;
}

/** Deleting without any filter/selection (i.e. everything) requires the caller to opt in explicitly. */
export async function bulkDelete(db, filters, timezone, { allowAll = false } = {}) {
  const { where, params } = buildWhere(filters, timezone);
  if (!where && !allowAll) throw new Error('Penghapusan massal tanpa filter atau pilihan ditolak.');
  const res = await db.query(`DELETE FROM barcodes b ${where || 'WHERE true'}`, params);
  return res.rowCount;
}

/** Keyset-paginated batch for streaming CSV export (never loads the whole table into memory). */
export function exportBatch(db, filters, timezone, afterId, limit) {
  const { where, params } = buildWhere(filters, timezone);
  const idIdx = params.length + 1;
  const cond = where ? `${where} AND b.id > $${idIdx}` : `WHERE b.id > $${idIdx}`;
  return db.rows(
    `SELECT ${COLUMNS} FROM barcodes b ${cond} ORDER BY b.id ASC LIMIT $${idIdx + 1}`,
    [...params, afterId, limit],
  );
}

export function counts(db) {
  return db.one(`
    SELECT count(*)::bigint AS total,
           count(*) FILTER (WHERE status = 'active' AND (expired_at IS NULL OR expired_at > now()) AND target_url IS NOT NULL)::bigint AS active,
           count(*) FILTER (WHERE status = 'active' AND (expired_at IS NULL OR expired_at > now()) AND target_url IS NULL)::bigint AS pending,
           count(*) FILTER (WHERE status = 'inactive')::bigint AS inactive,
           count(*) FILTER (WHERE status = 'active' AND expired_at IS NOT NULL AND expired_at <= now())::bigint AS expired,
           COALESCE(sum(scan_count), 0)::bigint AS total_scans
    FROM barcodes`);
}

export function topByScans(db, limit = 5) {
  return db.rows(
    `SELECT id, code, name, target_url, scan_count, status FROM barcodes
     WHERE scan_count > 0 ORDER BY scan_count DESC, id ASC LIMIT $1`,
    [limit],
  );
}

/* ------------------------------ history ------------------------------ */

/** changedVia: 'admin' (signed-in admin, changedBy = user id) or 'edit_link' (nobody signed in; changedIp says from where). */
export function insertHistory(db, { barcodeId, oldUrl, newUrl, changedBy = null, changedVia = 'admin', changedIp = null }) {
  return db.query(
    'INSERT INTO barcode_history (barcode_id, old_url, new_url, changed_by, changed_via, changed_ip) VALUES ($1, $2, $3, $4, $5, $6)',
    [barcodeId, oldUrl, newUrl, changedBy, changedVia, changedIp],
  );
}

export function historyForBarcode(db, barcodeId, limit = 50) {
  return db.rows(
    `SELECT h.id, h.old_url, h.new_url, h.changed_at, h.changed_via, h.changed_ip,
            u.username AS changed_by_username, u.name AS changed_by_name
     FROM barcode_history h LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.barcode_id = $1 ORDER BY h.changed_at DESC, h.id DESC LIMIT $2`,
    [barcodeId, limit],
  );
}

/** Global history feed with optional search and date range. */
export async function historyFeed(db, { q, from, to, page, perPage }, timezone) {
  const clauses = [];
  const params = [];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (q) {
    const p = add(`%${escapeLike(q)}%`);
    clauses.push(`(b.code ILIKE ${p} OR b.name ILIKE ${p} OR h.old_url ILIKE ${p} OR h.new_url ILIKE ${p})`);
  }
  let tzIdx;
  const tz = () => (tzIdx ??= add(timezone));
  if (from) clauses.push(`h.changed_at >= (${add(from)}::date)::timestamp AT TIME ZONE ${tz()}`);
  if (to) clauses.push(`h.changed_at < ((${add(to)}::date + 1)::timestamp AT TIME ZONE ${tz()})`);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const from_ = `FROM barcode_history h JOIN barcodes b ON b.id = h.barcode_id LEFT JOIN users u ON u.id = h.changed_by ${where}`;

  const [rows, count] = await Promise.all([
    db.rows(
      `SELECT h.id, h.old_url, h.new_url, h.changed_at, h.changed_via, h.changed_ip, b.code, b.name, u.username AS changed_by_username
       ${from_} ORDER BY h.changed_at DESC, h.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, perPage, (page - 1) * perPage],
    ),
    db.one(`SELECT count(*)::bigint AS total ${from_}`, params),
  ]);
  return { rows, total: count.total };
}

export function recentHistory(db, limit = 5) {
  return db.rows(
    `SELECT h.id, h.old_url, h.new_url, h.changed_at, h.changed_via, h.changed_ip, b.code, b.name, u.username AS changed_by_username
     FROM barcode_history h JOIN barcodes b ON b.id = h.barcode_id LEFT JOIN users u ON u.id = h.changed_by
     ORDER BY h.changed_at DESC, h.id DESC LIMIT $1`,
    [limit],
  );
}
