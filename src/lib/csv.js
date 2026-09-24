import { parse } from 'csv-parse/sync';

/** Excel in Indonesian locale saves CSV with ";" as separator, so the delimiter is detected from the header line. */
export function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

const HEADER_ALIASES = {
  name: ['name', 'nama', 'nama_barcode', 'judul', 'title'],
  description: ['description', 'deskripsi', 'keterangan', 'catatan', 'note', 'notes'],
  target_url: ['target_url', 'url', 'url_tujuan', 'tujuan', 'target', 'link', 'destination', 'destination_url'],
  status: ['status'],
  expired_at: ['expired_at', 'expired', 'expired_date', 'kedaluwarsa', 'kadaluarsa', 'tanggal_kedaluwarsa', 'berlaku_hingga'],
};

const ALIAS_LOOKUP = new Map(Object.entries(HEADER_ALIASES).flatMap(([key, list]) => list.map((a) => [a, key])));

export function canonicalHeader(header) {
  const norm = String(header ?? '')
    .replace(new RegExp(`^${String.fromCodePoint(0xfeff)}`), '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return ALIAS_LOOKUP.get(norm) ?? norm;
}

/**
 * Parses CSV text. Returns the canonical header list and rows as objects.
 * Row numbers follow spreadsheet convention (the header is row 1, first data row is row 2).
 * @throws {Error} with a user-friendly message on malformed input.
 */
export function parseCsv(buffer, { maxRows = 20000 } = {}) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  if (!text.trim()) throw new Error('File CSV kosong.');
  if (text.includes('\u0000')) throw new Error('File bukan CSV teks yang valid (mengandung data biner).');

  const delimiter = detectDelimiter(text);
  let records;
  try {
    records = parse(text, {
      delimiter,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: true,
    });
  } catch (err) {
    throw new Error(`File CSV tidak dapat dibaca: ${err.message}`);
  }
  if (records.length === 0) throw new Error('File CSV kosong.');

  const headers = records[0].map(canonicalHeader);
  const dataRecords = records.slice(1);
  if (dataRecords.length > maxRows) {
    throw new Error(`File berisi ${dataRecords.length.toLocaleString('id-ID')} baris data; batas per import adalah ${maxRows.toLocaleString('id-ID')} baris. Pecah menjadi beberapa file.`);
  }

  const rows = dataRecords.map((cells, i) => {
    const data = {};
    headers.forEach((h, idx) => {
      if (h && !(h in data)) data[h] = cells[idx] ?? '';
    });
    return { row: i + 2, data, raw: cells };
  });
  return { headers, rows, delimiter };
}

/** Escapes one CSV cell (RFC 4180) and neutralises spreadsheet formulas (CSV injection). */
export function csvCell(value, delimiter = ',') {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (s.includes('"') || s.includes(delimiter) || /[\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvLine(cells, delimiter = ',') {
  return `${cells.map((c) => csvCell(c, delimiter)).join(delimiter)}\r\n`;
}

/** UTF-8 byte order mark: makes Excel open the file as UTF-8. */
export const CSV_BOM = String.fromCodePoint(0xfeff);
