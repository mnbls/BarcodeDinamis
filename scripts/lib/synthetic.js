import { parseUserAgent } from '../../src/lib/ua.js';

// Realistic mix of agents. Weights add up to 100. device/browser/os are derived with the SAME parser
// the redirect endpoint uses, so generated statistics look exactly like real ones.
const AGENTS = [
  [34, 'Mozilla/5.0 (Linux; Android 13; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'],
  [22, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'],
  [8, 'Mozilla/5.0 (Linux; Android 12; SAMSUNG SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36'],
  [6, 'Mozilla/5.0 (Linux; Android 11; Redmi Note 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36 Instagram 330.0.0.0'],
  [12, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'],
  [4, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'],
  [4, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'],
  [3, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'],
  [4, 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'],
  [3, 'WhatsApp/2.24.5.78 A'],
];

const REFERERS = [null, null, null, 'https://www.instagram.com/', 'https://l.instagram.com/', 'https://www.google.com/', 'https://t.co/abc123'];

/**
 * Inserts `count` synthetic scans (raw log + daily rollup + barcode counters) in a handful of SQL
 * statements, spread over the last `days` days and skewed so that a few barcodes are scanned a lot.
 * Everything runs inside the database (generate_series), so a million rows takes seconds.
 */
export async function insertSyntheticScans(db, config, { count, days = 30 }) {
  if (count <= 0) return 0;

  let cumulative = 0;
  const templates = AGENTS.map(([weight, ua]) => {
    cumulative += weight;
    const { device, browser, os } = parseUserAgent(ua);
    return { ua, device, browser, os, cum: cumulative / 100 };
  });

  const { max: lastId } = await db.one('SELECT COALESCE(max(id), 0)::bigint AS max FROM barcode_scans');

  await db.query(
    `WITH ids AS (SELECT array_agg(id ORDER BY id) AS a FROM barcodes WHERE status = 'active'),
          tpl AS (SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::float8[]) AS t(ua, device, browser, os, cum)),
          refs AS (SELECT $6::text[] AS r),
          gen AS (
            SELECT random() AS r_b, random() AS r_t, random() AS r_u, random() AS r_ref, random() AS r_ip
            FROM generate_series(1, $7::int)
          )
     INSERT INTO barcode_scans (barcode_id, scanned_at, ip_address, user_agent, referer, device, browser, operating_system)
     SELECT ids.a[1 + floor(power(gen.r_b, 2.2) * array_length(ids.a, 1))::int],
            now() - (power(gen.r_t, 1.4) * $8::float8) * interval '1 day',
            ('10.' || floor(gen.r_ip * 255)::int || '.' || floor(gen.r_b * 255)::int || '.' || floor(gen.r_u * 254 + 1)::int)::inet,
            pick.ua,
            refs.r[1 + floor(gen.r_ref * array_length(refs.r, 1))::int],
            pick.device, pick.browser, pick.os
     FROM gen
     CROSS JOIN ids
     CROSS JOIN refs
     CROSS JOIN LATERAL (SELECT * FROM tpl WHERE tpl.cum >= gen.r_u ORDER BY tpl.cum LIMIT 1) AS pick
     WHERE ids.a IS NOT NULL`,
    [
      templates.map((t) => t.ua), templates.map((t) => t.device), templates.map((t) => t.browser),
      templates.map((t) => t.os), templates.map((t) => t.cum),
      REFERERS, count, days,
    ],
  );

  // Fold only the new rows into the rollup and the counters.
  await db.query(
    `INSERT INTO scan_stats_daily (barcode_id, stat_date, device, browser, operating_system, scans)
     SELECT barcode_id, (scanned_at AT TIME ZONE $2::text)::date, device, browser, operating_system, count(*)
     FROM barcode_scans WHERE id > $1
     GROUP BY 1, 2, 3, 4, 5
     ON CONFLICT (barcode_id, stat_date, device, browser, operating_system)
     DO UPDATE SET scans = scan_stats_daily.scans + EXCLUDED.scans`,
    [lastId, config.timezone],
  );
  await db.query(
    `UPDATE barcodes b SET scan_count = b.scan_count + s.c, last_scanned_at = GREATEST(b.last_scanned_at, s.m)
     FROM (SELECT barcode_id, count(*) AS c, max(scanned_at) AS m FROM barcode_scans WHERE id > $1 GROUP BY barcode_id) s
     WHERE b.id = s.barcode_id`,
    [lastId],
  );

  const { n } = await db.one('SELECT count(*)::bigint AS n FROM barcode_scans WHERE id > $1', [lastId]);
  return n;
}
