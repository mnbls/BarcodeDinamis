// Calendar/timezone helpers. Instants are stored as timestamptz (UTC); "days" are local
// dates in APP_TIMEZONE. Conversions between local wall-clock time and instants are done
// by PostgreSQL (AT TIME ZONE), so DST rules always come from the database's tz data.

const formatters = new Map();

function fmt(timeZone, key, options) {
  const cacheKey = `${timeZone}|${key}`;
  let f = formatters.get(cacheKey);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', ...options });
    formatters.set(cacheKey, f);
  }
  return f;
}

function parts(date, timeZone) {
  const f = fmt(timeZone, 'full', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out = {};
  for (const p of f.formatToParts(date)) out[p.type] = p.value;
  return out;
}

const isValidDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());

/** 23-09-2026 10:00 */
export function formatDateTime(value, timeZone) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (!isValidDate(d)) return '';
  const p = parts(d, timeZone);
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}

/** 23-09-2026 */
export function formatDate(value, timeZone) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-');
    return `${d}-${m}-${y}`;
  }
  const d = value instanceof Date ? value : new Date(value);
  if (!isValidDate(d)) return '';
  const p = parts(d, timeZone);
  return `${p.day}-${p.month}-${p.year}`;
}

/** 2026-09-23T10:00 (value of <input type="datetime-local">) */
export function toInputDateTime(value, timeZone) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (!isValidDate(d)) return '';
  const p = parts(d, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** 2026-09-23 10:00:00 (CSV export, local time) */
export function toLocalSql(value, timeZone) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (!isValidDate(d)) return '';
  const p = parts(d, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Current local date as YYYY-MM-DD. */
export function todayLocal(timeZone, now = new Date()) {
  const p = parts(now, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Current local wall-clock time as "YYYY-MM-DD HH:mm:ss" (lexicographically comparable). */
export function nowLocalSql(timeZone, now = new Date()) {
  return toLocalSql(now, timeZone);
}

function validYmd(y, m, d) {
  if (y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const pad = (n) => String(n).padStart(2, '0');

/** Validates YYYY-MM-DD. */
export function isValidDateOnly(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  return Boolean(m) && validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Parses a local date/time typed by a person or found in a CSV cell.
 * Accepts: YYYY-MM-DD[ T]HH:mm[:ss], YYYY-MM-DD, DD-MM-YYYY[ HH:mm[:ss]], DD/MM/YYYY[ HH:mm[:ss]].
 * A date without a time means the END of that day (23:59:59).
 * Returns "YYYY-MM-DD HH:mm:ss" (local wall-clock) or null when invalid.
 */
export function parseLocalDateTime(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;

  let y;
  let mo;
  let d;
  let rest;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(.+))?$/.exec(s);
  if (m) {
    [y, mo, d, rest] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
  } else if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T\s]+(.+))?$/.exec(s))) {
    [d, mo, y, rest] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
  } else {
    return null;
  }
  if (!validYmd(y, mo, d)) return null;

  let h = 23;
  let mi = 59;
  let sec = 59;
  if (rest !== undefined) {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(rest.trim());
    if (!t) return null;
    h = Number(t[1]);
    mi = Number(t[2]);
    sec = t[3] === undefined ? 0 : Number(t[3]);
    if (h > 23 || mi > 59 || sec > 59) return null;
  }
  return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(sec)}`;
}

/** Adds (or subtracts) whole days to a YYYY-MM-DD string. */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Inclusive number of days between two YYYY-MM-DD strings (from <= to). */
export function daysInclusive(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

/** Monday (ISO week start) of the week containing the given date. */
export function startOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(dateStr, -((dow + 6) % 7));
}

export function startOfMonth(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}
