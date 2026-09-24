export const PER_PAGE_OPTIONS = [10, 25, 50, 100];
export const DEFAULT_PER_PAGE = 25;

export function parsePage(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : 1;
}

export function parsePerPage(value, fallback = DEFAULT_PER_PAGE) {
  const n = Number.parseInt(value, 10);
  return PER_PAGE_OPTIONS.includes(n) ? n : fallback;
}

/**
 * Builds pagination state, including a compact list of page links, e.g. [1, '...', 4, 5, 6, '...', 40].
 */
export function buildPagination({ page, perPage, total, around = 1 }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), totalPages);
  const from = total === 0 ? 0 : (current - 1) * perPage + 1;
  const to = Math.min(total, current * perPage);

  const wanted = new Set([1, totalPages, current]);
  for (let i = 1; i <= around; i += 1) {
    wanted.add(current - i);
    wanted.add(current + i);
  }
  const sorted = [...wanted].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const pages = [];
  sorted.forEach((p, idx) => {
    if (idx > 0 && p - sorted[idx - 1] > 1) pages.push('...');
    pages.push(p);
  });

  return { page: current, perPage, total, totalPages, from, to, hasPrev: current > 1, hasNext: current < totalPages, pages };
}

/** Builds a query string from an object, skipping empty values. Returns '' or '?a=1&b=2'. */
export function toQuery(params = {}, overrides = {}) {
  const merged = { ...params, ...overrides };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
