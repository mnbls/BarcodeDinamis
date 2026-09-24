import { isPgError, PG } from '../../db/pool.js';
import { anonymizeIp, normalizeIp } from '../../lib/ip.js';
import { cleanHeader, truncate } from '../../lib/text.js';
import { parseUserAgent } from '../../lib/ua.js';

// One statement, one round trip, atomic: raw event + daily rollup + per-barcode counter.
// Statistics are read from the rollup, so dashboards stay fast no matter how large
// barcode_scans grows. scan_count/last_scanned_at are not indexed, so the UPDATE is a HOT update.
const RECORD_SQL = `
WITH ins AS (
  INSERT INTO barcode_scans (barcode_id, scanned_at, ip_address, user_agent, referer, device, browser, operating_system)
  VALUES ($1::bigint, COALESCE($9::timestamptz, now()), $2::inet, $3::text, $4::text, $5::text, $6::text, $7::text)
  RETURNING scanned_at
), roll AS (
  INSERT INTO scan_stats_daily (barcode_id, stat_date, device, browser, operating_system, scans)
  SELECT $1::bigint, (scanned_at AT TIME ZONE $8::text)::date, $5::text, $6::text, $7::text, 1 FROM ins
  ON CONFLICT (barcode_id, stat_date, device, browser, operating_system)
  DO UPDATE SET scans = scan_stats_daily.scans + 1
  RETURNING 1
)
UPDATE barcodes SET scan_count = scan_count + 1, last_scanned_at = GREATEST(last_scanned_at, (SELECT scanned_at FROM ins))
WHERE id = $1::bigint`;

/** Keeps only origin + path of a Referer (query strings and fragments can carry tokens/PII). */
function sanitizeReferer(raw) {
  const cleaned = cleanHeader(raw, 1024);
  if (!cleaned) return null;
  try {
    const u = new URL(cleaned);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return truncate(`${u.origin}${u.pathname}`, 512);
  } catch {
    return null;
  }
}

/**
 * Records scans without ever slowing down or breaking a redirect:
 * writes happen after the response was sent, failures are logged, and a hard cap on in-flight
 * writes drops analytics (never redirects) if the database is overloaded.
 */
export function createScanRecorder({ db, config, logger }) {
  const pending = new Set();
  let dropped = 0;

  async function write(event) {
    const ip = normalizeIp(event.ip);
    const userAgent = cleanHeader(event.userAgent, 512);
    const { device, browser, os } = parseUserAgent(userAgent ?? '');
    const params = [
      event.barcodeId,
      config.privacy.anonymizeIp ? anonymizeIp(ip) : ip,
      userAgent,
      sanitizeReferer(event.referer),
      device,
      browser,
      os,
      config.timezone,
      event.scannedAt ?? null, // only for imports/backfills/tests; live scans use the database clock
    ];

    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.query(RECORD_SQL, params);
        return;
      } catch (err) {
        if (isPgError(err, PG.FK_VIOLATION)) return; // barcode deleted between lookup and write
        const retryable = isPgError(err, PG.DEADLOCK) || isPgError(err, PG.SERIALIZATION);
        if (retryable && attempt < 3) continue;
        throw err;
      }
    }
  }

  return {
    record(event) {
      if (pending.size >= config.redirect.maxPendingScanWrites) {
        dropped += 1;
        if (dropped === 1 || dropped % 500 === 0) logger.warn({ dropped }, 'scan write queue is full, dropping analytics events');
        return;
      }
      const promise = write(event)
        .catch((err) => logger.error({ err, barcodeId: event.barcodeId }, 'failed to record scan'))
        .finally(() => pending.delete(promise));
      pending.add(promise);
    },

    /** Resolves when every in-flight write has finished (graceful shutdown, tests). */
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },

    get pending() {
      return pending.size;
    },
    get dropped() {
      return dropped;
    },
  };
}
