import { once } from 'node:events';
import { CSV_BOM, csvLine } from '../../lib/csv.js';
import { toLocalSql } from '../../lib/dates.js';
import * as repo from '../barcodes/barcodes.repo.js';

const HEADERS = [
  'code', 'name', 'description', 'target_type', 'target_url', 'qr_url', 'status', 'state',
  'expired_at', 'scan_count', 'last_scanned_at', 'created_at', 'updated_at',
];
const BATCH_SIZE = 2000;

/** Delimiter choice: comma (default) or semicolon (what Excel expects with Indonesian regional settings). */
export const delimiterFor = (value) => (value === 'semicolon' ? ';' : ',');

/**
 * Streams barcodes as CSV. Rows are read in keyset-paginated batches and written straight to the
 * response, so memory stays flat whether 100 or 100.000 rows match. Cells are protected against
 * spreadsheet formula injection (see csvCell).
 */
export async function streamBarcodesCsv(ctx, res, { filters, delimiter = ',', filename }) {
  const { db, config } = ctx;
  const tz = config.timezone;

  res.status(200).set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });

  res.write(CSV_BOM + csvLine(HEADERS, delimiter));

  let afterId = 0;
  try {
    for (;;) {
      const rows = await repo.exportBatch(db, filters, tz, afterId, BATCH_SIZE);
      if (rows.length === 0) break;

      let chunk = '';
      for (const r of rows) {
        chunk += csvLine(
          [
            r.code, r.name, r.description ?? '', r.target_type, r.target_url ?? '', `${config.appUrl}/b/${r.code}`,
            r.status, r.state, toLocalSql(r.expired_at, tz), r.scan_count, toLocalSql(r.last_scanned_at, tz),
            toLocalSql(r.created_at, tz), toLocalSql(r.updated_at, tz),
          ],
          delimiter,
        );
      }
      if (!res.write(chunk)) await once(res, 'drain');
      afterId = rows[rows.length - 1].id;
      if (res.destroyed) return;
    }
    res.end();
  } catch (err) {
    // Headers are already sent: the only honest option is to abort the transfer.
    ctx.logger.error({ err }, 'csv export failed mid-stream');
    res.destroy(err);
  }
}

export function exportFilename(timezone, now = new Date()) {
  const stamp = toLocalSql(now, timezone).replace(/[-:]/g, '').replace(' ', '-').slice(0, 13);
  return `barcodes-${stamp}.csv`;
}
