import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parseCsv } from '../../src/lib/csv.js';
import { todayLocal } from '../../src/lib/dates.js';
import * as analytics from '../../src/modules/analytics/analytics.repo.js';
import { insertSyntheticScans } from '../../scripts/lib/synthetic.js';
import { insertBarcodes, loginAgent, makeUser, postForm, scan, startApp } from '../helpers/app.js';

const TOTAL = 10_000;
const time = async (fn) => {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
};

/**
 * Capacity check for the stated target: 10.000 barcodes (plus a large scan history).
 * Time limits are deliberately generous (CI machines vary); the assertions that matter are the
 * correctness ones and the query plans, which do not depend on machine speed.
 */
describe(`${TOTAL.toLocaleString('id-ID')} barcodes`, () => {
  let t;
  let admin;
  before(async () => {
    t = await startApp();
    await makeUser(t.ctx, { username: 'admin' });
    admin = await loginAgent(t);

    const rows = Array.from({ length: TOTAL }, (_, i) => {
      const n = i + 1;
      return {
        name: `${n % 3 === 0 ? 'Kopi' : n % 3 === 1 ? 'Teh' : 'Jamu'} Produk ${String(n).padStart(5, '0')}`,
        description: n % 10 === 0 ? `Catatan ${n}` : null,
        targetUrl: `https://example.com/produk/${n}?ref=qr`,
        status: n % 20 === 0 ? 'inactive' : 'active',
        expiredLocal: n % 50 === 0 ? '2001-01-01 00:00:00' : null,
      };
    });
    const { ms } = await time(async () => {
      for (let i = 0; i < rows.length; i += 1000) await insertBarcodes(t.ctx, rows.slice(i, i + 1000));
    });
    assert.ok(ms < 60_000, `creating ${TOTAL} barcodes took ${Math.round(ms)} ms`);
  });
  after(() => t.close());

  const codesOf = (html) => [...html.matchAll(/class="code-link" href="\/admin\/barcodes\/(BR-\d+)"/g)].map((m) => m[1]);

  it('stores exactly 10.000 unique, contiguous, well-formed codes protected by a UNIQUE index', async () => {
    const stats = await t.db.one('SELECT count(*)::int AS n, count(DISTINCT code)::int AS uniq, min(code) AS lo, max(code) AS hi FROM barcodes');
    assert.deepEqual({ ...stats }, { n: TOTAL, uniq: TOTAL, lo: 'BR-000001', hi: 'BR-010000' });
    const idx = await t.db.rows("SELECT indexdef FROM pg_indexes WHERE tablename = 'barcodes' AND indexname = 'barcodes_code_uidx'");
    assert.match(idx[0].indexdef, /CREATE UNIQUE INDEX/);
    await assert.rejects(t.db.query("INSERT INTO barcodes (code, name, target_url) VALUES ('BR-000001', 'dup', 'https://x.test')"), /duplicate key|unique/i);
  });

  it('has indexes on every column the brief names', async () => {
    const defs = (await t.db.rows("SELECT indexdef FROM pg_indexes WHERE tablename IN ('barcodes','barcode_scans','barcode_history','scan_stats_daily')")).map((r) => r.indexdef).join('\n');
    for (const needle of ['(code)', '(status, created_at DESC)', '(created_at DESC)', '(barcode_id, scanned_at DESC)', '(scanned_at)', '(barcode_id, changed_at DESC)']) {
      assert.ok(defs.includes(needle), `missing index on ${needle}`);
    }
  });

  it('the redirect lookup uses the unique index (no sequential scan over 10.000 rows)', async () => {
    const plan = await t.db.rows("EXPLAIN (FORMAT JSON) SELECT id, code, target_url, status, expired_at FROM barcodes WHERE code = 'BR-005000'");
    const text = JSON.stringify(plan);
    assert.match(text, /barcodes_code_uidx/);
    assert.ok(!/Seq Scan/.test(text), 'must not be a sequential scan');
  });

  it('list pages are cheap and correct: first, middle, last, out of range, 100 per page', async () => {
    const first = await time(() => admin.get('/admin/barcodes'));
    assert.equal(first.value.status, 200);
    assert.match(first.value.text, /1-25 dari 10\.000/);
    assert.equal(codesOf(first.value.text).length, 25);
    assert.equal(codesOf(first.value.text)[0], 'BR-010000', 'newest first');
    assert.ok(first.ms < 3000, `first page took ${Math.round(first.ms)} ms`);
    assert.match(first.value.text, /Halaman 400/);

    const middle = await admin.get('/admin/barcodes?page=200&sort=code&dir=asc');
    assert.equal(codesOf(middle.text)[0], 'BR-004976');
    const last = await admin.get('/admin/barcodes?page=400&sort=code&dir=asc');
    assert.deepEqual([codesOf(last.text).length, codesOf(last.text).at(-1)], [25, 'BR-010000']);
    assert.match(last.text, /9\.976-10\.000 dari 10\.000/);
    const beyond = await admin.get('/admin/barcodes?page=99999');
    assert.match(beyond.text, /9\.976-10\.000 dari 10\.000/, 'clamped to the last page');
    const big = await admin.get('/admin/barcodes?per_page=100&page=100&sort=code&dir=asc');
    assert.deepEqual([codesOf(big.text).length, codesOf(big.text)[0], codesOf(big.text).at(-1)], [100, 'BR-009901', 'BR-010000']);
    // The HTML never carries all 10.000 rows at once.
    assert.ok(first.value.text.length < 400_000, `page is ${first.value.text.length} bytes`);
  });

  it('search finds the right rows quickly: by exact code, by name fragment, by URL', async () => {
    const byCode = await time(() => admin.get('/admin/barcodes?q=BR-005000'));
    assert.deepEqual(codesOf(byCode.value.text), ['BR-005000']);
    assert.ok(byCode.ms < 2000, `code search ${Math.round(byCode.ms)} ms`);

    const expected = (await t.db.one("SELECT count(*)::int AS n FROM barcodes WHERE name ILIKE '%kopi produk 0100%'")).n;
    const byName = await admin.get(`/admin/barcodes?q=${encodeURIComponent('kopi produk 0100')}&per_page=100`);
    assert.equal(codesOf(byName.text).length, expected);
    assert.ok(expected > 0);

    const byUrl = await admin.get(`/admin/barcodes?q=${encodeURIComponent('produk/7777?')}`);
    assert.deepEqual(codesOf(byUrl.text), ['BR-007777']);

    const total = await admin.get('/admin/barcodes?q=Kopi');
    assert.match(total.text, /3\.333 dari 3\.333|1-25 dari 3\.333/);
  });

  it('status filters partition the table exactly: active + inactive + expired = 10.000', async () => {
    const count = async (status) => Number(/dari ([\d.]+)/.exec((await admin.get(`/admin/barcodes?status=${status}`)).text)?.[1].replace(/\./g, ''));
    const [active, inactive, expired] = [await count('active'), await count('inactive'), await count('expired')];
    assert.equal(inactive, 500);
    assert.equal(expired, 100, 'every 50th is expired, except the 100 that are also inactive (every 100th wins as inactive)');
    assert.equal(active + inactive + expired, TOTAL);
    const dash = await admin.get('/admin');
    assert.match(dash.text, /Total barcode[\s\S]*?stat__value">10\.000</);
  });

  it('exports all 10.000 rows as a stream: complete, unique, ordered', async () => {
    const { ms, value } = await time(() => admin.get('/admin/barcodes/export.csv'));
    const { rows } = parseCsv(value.text);
    assert.equal(rows.length, TOTAL);
    assert.equal(new Set(rows.map((r) => r.data.code)).size, TOTAL);
    assert.equal(rows[0].data.code, 'BR-000001');
    assert.equal(rows.at(-1).data.code, 'BR-010000');
    assert.ok(ms < 30_000, `export took ${Math.round(ms)} ms`);
  });

  it('scans of any barcode redirect correctly, including the first and the 10.000th', async () => {
    for (const n of [1, 2, 4999, 10_000]) {
      const code = `BR-${String(n).padStart(6, '0')}`;
      const res = await scan(t, code);
      const inactiveOrExpired = n % 20 === 0 || n % 50 === 0;
      if (inactiveOrExpired) assert.ok([403, 410].includes(res.status), `${code} -> ${res.status}`);
      else assert.equal(res.headers.location, `https://example.com/produk/${n}?ref=qr`);
    }
    const res = await scan(t, 'BR-007777');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, 'https://example.com/produk/7777?ref=qr');
  });

  it('handles 200 concurrent scans over different codes without losing any', async () => {
    const before = (await t.db.one('SELECT COALESCE(sum(scan_count), 0)::int AS n FROM barcodes')).n;
    const numbers = Array.from({ length: 200 }, (_, i) => 1 + ((i * 47) % 9000)); // 47 and 9000 are coprime: all distinct
    const code = (n) => `BR-${String(n).padStart(6, '0')}`;
    const { ms } = await time(() => Promise.all(numbers.map((n) => t.request().get(`/b/${code(n)}`))));
    await t.ctx.recorder.idle();
    const after = (await t.db.one('SELECT COALESCE(sum(scan_count), 0)::int AS n FROM barcodes')).n;
    const shouldCount = numbers.filter((n) => n % 20 !== 0 && n % 50 !== 0).length; // the rest are inactive / expired
    assert.equal(after - before, shouldCount, 'every successful redirect is counted exactly once');
    assert.ok(ms < 30_000, `200 scans took ${Math.round(ms)} ms`);
  });

  it('statistics stay fast and consistent with 300.000 scans in the log', async () => {
    const generated = await time(() => insertSyntheticScans(t.db, t.config, { count: 300_000, days: 60 }));
    assert.ok(generated.ms < 120_000, `generating scans took ${Math.round(generated.ms)} ms`);

    const consistency = await t.db.one(`SELECT
        (SELECT count(*) FROM barcode_scans)::bigint AS raw,
        (SELECT COALESCE(sum(scans), 0) FROM scan_stats_daily)::bigint AS rolled,
        (SELECT COALESCE(sum(scan_count), 0) FROM barcodes)::bigint AS counters`);
    assert.ok(consistency.raw >= 300_000);
    assert.equal(consistency.rolled, consistency.raw, 'rollup matches the raw log');
    assert.equal(consistency.counters, consistency.raw, 'counters match the raw log');

    const today = todayLocal('Asia/Jakarta');
    const queries = {
      summary: () => analytics.summary(t.db, 'Asia/Jakarta'),
      series60: () => analytics.dailySeries(t.db, '2026-01-01', today),
      devices: () => analytics.breakdown(t.db, 'device', '2026-01-01', today),
      browsers: () => analytics.breakdown(t.db, 'browser', '2026-01-01', today),
      top: () => analytics.topBarcodes(t.db, '2026-01-01', today, 10),
    };
    for (const [name, run] of Object.entries(queries)) {
      const { ms } = await time(run);
      assert.ok(ms < 2500, `${name} took ${Math.round(ms)} ms on 300k scans`);
    }

    const dash = await time(() => admin.get('/admin'));
    assert.equal(dash.value.status, 200);
    assert.ok(dash.ms < 4000, `dashboard took ${Math.round(dash.ms)} ms`);
    const analyticsPage = await time(() => admin.get('/admin/analytics?range=90'));
    assert.equal(analyticsPage.value.status, 200);
    assert.ok(analyticsPage.ms < 4000, `analytics page took ${Math.round(analyticsPage.ms)} ms`);

    const top = await analytics.topBarcodes(t.db, '2000-01-01', today, 1);
    assert.ok(top[0].scans > 1000, 'the skewed distribution makes a few barcodes very popular');
  });

  it('bulk actions scale: deactivate all 10.000 in one statement, then delete everything (cascading 300k scans)', async () => {
    const off = await time(() => postForm(admin, '/admin/barcodes/bulk', { action: 'deactivate', select_all_matching: '1' }, { tokenPage: '/admin/barcodes' }));
    assert.equal(off.value.status, 302);
    const counts = await t.db.one("SELECT count(*) FILTER (WHERE status = 'inactive')::int AS off FROM barcodes");
    assert.equal(counts.off, TOTAL);
    assert.ok(off.ms < 15_000, `bulk deactivate took ${Math.round(off.ms)} ms`);

    const del = await time(() => postForm(admin, '/admin/barcodes/bulk', { action: 'delete', select_all_matching: '1', confirm_text: 'HAPUS' }, { tokenPage: '/admin/barcodes' }));
    assert.equal(del.value.status, 302);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_scans')).n, 0, 'scans cascade');
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM scan_stats_daily')).n, 0, 'rollups cascade');
    assert.ok(del.ms < 60_000, `bulk delete took ${Math.round(del.ms)} ms`);
  });
});
