import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import nunjucks from 'nunjucks';
import { formatDate, formatDateTime } from './lib/dates.js';
import { iconSvg } from './lib/icons.js';
import { toQuery } from './lib/pagination.js';
import { TARGET_TYPE_LABELS, TARGET_TYPE_META } from './modules/barcodes/targets.js';

const VIEWS_DIR = path.resolve(import.meta.dirname, 'views');
export const PUBLIC_DIR = path.resolve(import.meta.dirname, 'public');

const STATE_LABELS = { active: 'Aktif', inactive: 'Nonaktif', expired: 'Kedaluwarsa', pending: 'Belum diisi' };
const DEVICE_LABELS = { mobile: 'Ponsel', tablet: 'Tablet', desktop: 'Desktop', bot: 'Bot / crawler', unknown: 'Tidak diketahui' };

/** Short hash of the CSS/JS files: appended to asset URLs so browsers fetch new versions after a deploy. */
function computeAssetVersion() {
  const hash = createHash('sha1');
  for (const dir of ['css', 'js']) {
    const full = path.join(PUBLIC_DIR, dir);
    for (const name of readdirSync(full).sort()) hash.update(readFileSync(path.join(full, name)));
  }
  return hash.digest('hex').slice(0, 10);
}

export function setupViews(app, config) {
  const env = nunjucks.configure(VIEWS_DIR, {
    autoescape: true, // {{ value }} is HTML-escaped by default: the XSS baseline
    express: app,
    noCache: !config.isProd,
    trimBlocks: true,
    lstripBlocks: true,
  });
  app.set('view engine', 'njk');

  const safe = (html) => new nunjucks.runtime.SafeString(html);
  const number = new Intl.NumberFormat('id-ID');
  const compact = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });

  env.addGlobal('icon', (name, size = 20, className = '') => safe(iconSvg(name, { size, className })));
  env.addGlobal('qs', (params, overrides) => toQuery(params, overrides));
  env.addGlobal('assetVersion', computeAssetVersion());
  env.addGlobal('targetTypeMeta', TARGET_TYPE_META);
  env.addGlobal('targetTypeLabels', TARGET_TYPE_LABELS);
  env.addGlobal('app', { name: config.appName, url: config.appUrl, version: config.version, env: config.env, timezone: config.timezone });

  env.addFilter('dt', (v) => formatDateTime(v, config.timezone));
  env.addFilter('date', (v) => formatDate(v, config.timezone));
  env.addFilter('num', (v) => number.format(Number(v ?? 0)));
  /** 10.000 stays exact; from 100.000 up it becomes 120 rb / 1,2 jt (stat tiles). */
  env.addFilter('compact', (v) => {
    const n = Number(v ?? 0);
    return Math.abs(n) < 100_000 ? number.format(n) : compact.format(n);
  });
  env.addFilter('pct', (part, total) => (Number(total) > 0 ? `${Math.round((Number(part) / Number(total)) * 100)}%` : '0%'));
  env.addFilter('stateLabel', (v) => STATE_LABELS[v] ?? v);
  env.addFilter('typeLabel', (v) => TARGET_TYPE_LABELS[v] ?? v);
  env.addFilter('deviceLabel', (v) => DEVICE_LABELS[v] ?? v);
  /** Host part of a URL for compact display (falls back to the raw value for mailto:/tel:). */
  env.addFilter('displayUrl', (v) => {
    const s = String(v ?? '');
    try {
      const u = new URL(s);
      if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
    } catch {
      /* not a URL */
    }
    return s;
  });

  return env;
}
