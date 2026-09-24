// All statistics are aggregation queries over scan_stats_daily (a rollup with one row per
// barcode/day/device/browser/os), never over the raw scan log.

const BREAKDOWN_COLUMNS = { device: 'device', browser: 'browser', os: 'operating_system' };

/** Scan totals for today / yesterday / rolling 7 days / calendar week / calendar month. */
export function summary(db, timezone, barcodeId = null) {
  const byBarcode = barcodeId ? 'AND s.barcode_id = $2::bigint' : '';
  return db.one(
    `WITH t AS (SELECT (now() AT TIME ZONE $1::text)::date AS today)
     SELECT
       COALESCE(sum(s.scans) FILTER (WHERE s.stat_date = t.today), 0)::bigint AS today,
       COALESCE(sum(s.scans) FILTER (WHERE s.stat_date = t.today - 1), 0)::bigint AS yesterday,
       COALESCE(sum(s.scans) FILTER (WHERE s.stat_date > t.today - 7), 0)::bigint AS last7,
       COALESCE(sum(s.scans) FILTER (WHERE s.stat_date > t.today - 14 AND s.stat_date <= t.today - 7), 0)::bigint AS prev7,
       COALESCE(sum(s.scans) FILTER (WHERE s.stat_date >= date_trunc('week', t.today::timestamp)::date), 0)::bigint AS this_week,
       COALESCE(sum(s.scans) FILTER (WHERE s.stat_date >= date_trunc('month', t.today::timestamp)::date), 0)::bigint AS this_month
     FROM t LEFT JOIN scan_stats_daily s ON s.stat_date > t.today - 45 ${byBarcode}`,
    barcodeId ? [timezone, barcodeId] : [timezone],
  );
}

/** One row per calendar day in [from, to] (zero-filled), as { day: 'YYYY-MM-DD', scans }. */
export function dailySeries(db, from, to, barcodeId = null) {
  const byBarcode = barcodeId ? 'AND barcode_id = $3::bigint' : '';
  return db.rows(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(x.scans, 0)::int AS scans
     FROM generate_series($1::date::timestamp, $2::date::timestamp, interval '1 day') AS d
     LEFT JOIN (
       SELECT stat_date, sum(scans) AS scans FROM scan_stats_daily
       WHERE stat_date BETWEEN $1::date AND $2::date ${byBarcode}
       GROUP BY stat_date
     ) x ON x.stat_date = d::date
     ORDER BY d`,
    barcodeId ? [from, to, barcodeId] : [from, to],
  );
}

/** Distribution over one dimension ('device' | 'browser' | 'os') inside a date range. */
export async function breakdown(db, dimension, from, to, barcodeId = null, limit = 8) {
  const column = Object.hasOwn(BREAKDOWN_COLUMNS, dimension) ? BREAKDOWN_COLUMNS[dimension] : null;
  if (!column) throw new Error(`Dimensi tidak dikenal: ${dimension}`);
  const byBarcode = barcodeId ? 'AND barcode_id = $4::bigint' : '';
  return db.rows(
    `SELECT ${column} AS label, sum(scans)::bigint AS scans
     FROM scan_stats_daily
     WHERE stat_date BETWEEN $1::date AND $2::date ${byBarcode}
     GROUP BY ${column}
     ORDER BY scans DESC, ${column} ASC
     LIMIT $3`,
    barcodeId ? [from, to, limit, barcodeId] : [from, to, limit],
  );
}

/** Total scans inside [from, to] (used for "vs previous period" comparisons). */
export async function rangeTotal(db, from, to, barcodeId = null) {
  const byBarcode = barcodeId ? 'AND barcode_id = $3::bigint' : '';
  const row = await db.one(
    `SELECT COALESCE(sum(scans), 0)::bigint AS total FROM scan_stats_daily
     WHERE stat_date BETWEEN $1::date AND $2::date ${byBarcode}`,
    barcodeId ? [from, to, barcodeId] : [from, to],
  );
  return row.total;
}

/** Most scanned barcodes inside a date range. */
export function topBarcodes(db, from, to, limit = 10) {
  return db.rows(
    `SELECT b.id, b.code, b.name, b.status, sum(s.scans)::bigint AS scans
     FROM scan_stats_daily s JOIN barcodes b ON b.id = s.barcode_id
     WHERE s.stat_date BETWEEN $1::date AND $2::date
     GROUP BY b.id, b.code, b.name, b.status
     ORDER BY scans DESC, b.id ASC
     LIMIT $3`,
    [from, to, limit],
  );
}

/** Latest raw scans of one barcode (served by the (barcode_id, scanned_at) index). */
export function recentScans(db, barcodeId, limit = 10) {
  return db.rows(
    `SELECT id, scanned_at, host(ip_address) AS ip_address, referer, device, browser, operating_system
     FROM barcode_scans WHERE barcode_id = $1 ORDER BY scanned_at DESC, id DESC LIMIT $2`,
    [barcodeId, limit],
  );
}
