import { addDays, daysInclusive, formatDate, startOfMonth, todayLocal } from '../../lib/dates.js';
import { cleanDateFilter } from '../barcodes/barcodes.validation.js';
import * as repo from './analytics.repo.js';

export const RANGE_PRESETS = [
  { key: '7', label: '7 hari' },
  { key: '30', label: '30 hari' },
  { key: '90', label: '90 hari' },
  { key: 'month', label: 'Bulan ini' },
];

const MAX_RANGE_DAYS = 366;

/**
 * Resolves the date range of an analytics view from the query string:
 * ?range=7|30|90|month  or  ?from=YYYY-MM-DD&to=YYYY-MM-DD (max 366 days). Invalid input falls back to the default.
 */
export function resolveRange(query, timezone, defaultKey = '30') {
  const today = todayLocal(timezone);
  const from = cleanDateFilter(query.from);
  const to = cleanDateFilter(query.to);

  if (from && to && from <= to && daysInclusive(from, to) <= MAX_RANGE_DAYS) {
    return { key: 'custom', from, to, days: daysInclusive(from, to), label: `${formatDate(from)} s/d ${formatDate(to)}` };
  }

  const key = RANGE_PRESETS.some((p) => p.key === String(query.range)) ? String(query.range) : defaultKey;
  if (key === 'month') {
    const start = startOfMonth(today);
    return { key, from: start, to: today, days: daysInclusive(start, today), label: 'Bulan ini' };
  }
  const days = Number(key);
  return { key, from: addDays(today, -(days - 1)), to: today, days, label: `${days} hari terakhir` };
}

/** Total, daily average and busiest day of a zero-filled daily series. */
export function seriesStats(series) {
  const total = series.reduce((n, p) => n + p.scans, 0);
  const peak = series.reduce((best, p) => (p.scans > (best?.scans ?? -1) ? p : best), null);
  return { total, days: series.length, average: series.length ? total / series.length : 0, peak: peak && peak.scans > 0 ? peak : null };
}

/** Percentage change versus the previous period; null when there is nothing to compare with. */
export function deltaPercent(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * Everything the analytics widgets need for one range (global, or for one barcode when barcodeId is given).
 * All queries are aggregations over the daily rollup, executed in parallel.
 */
export async function loadRangeReport(db, range, { barcodeId = null, topLimit = 10 } = {}) {
  const prevTo = addDays(range.from, -1);
  const prevFrom = addDays(range.from, -range.days);
  const [series, devices, browsers, systems, previousTotal, top] = await Promise.all([
    repo.dailySeries(db, range.from, range.to, barcodeId),
    repo.breakdown(db, 'device', range.from, range.to, barcodeId),
    repo.breakdown(db, 'browser', range.from, range.to, barcodeId),
    repo.breakdown(db, 'os', range.from, range.to, barcodeId),
    repo.rangeTotal(db, prevFrom, prevTo, barcodeId),
    barcodeId ? Promise.resolve([]) : repo.topBarcodes(db, range.from, range.to, topLimit),
  ]);
  const stats = seriesStats(series);
  return { series, devices, browsers, systems, top, stats, previousTotal, delta: deltaPercent(stats.total, previousTotal) };
}
