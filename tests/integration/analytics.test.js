import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { addDays, startOfMonth, startOfWeek, todayLocal } from '../../src/lib/dates.js';
import * as analytics from '../../src/modules/analytics/analytics.repo.js';
import { resolveRange } from '../../src/modules/analytics/analytics.service.js';
import { UA, insertBarcodes, loginAgent, makeUser, scan, startApp } from '../helpers/app.js';

const TZ = 'Asia/Jakarta';

describe('scan statistics', () => {
  let t;
  let admin;
  let a;
  let b;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await makeUser(t.ctx, { username: 'admin' });
    admin = await loginAgent(t);
    [a, b] = await insertBarcodes(t.ctx, [{ name: 'Alfa' }, { name: 'Beta' }]);
  });

  /** Records a scan at an exact instant (the same code path as a live scan). */
  const record = async (barcode, when, ua = UA.android) => {
    t.ctx.recorder.record({ barcodeId: barcode.id, ip: '10.0.0.1', userAgent: ua, referer: null, scannedAt: when });
    await t.ctx.recorder.idle();
  };
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

  it('every scan updates the counter, the raw log and the daily rollup consistently', async () => {
    for (let i = 0; i < 5; i += 1) await scan(t, a.code, { ua: i < 3 ? UA.android : UA.windowsChrome });
    await scan(t, b.code, { ua: UA.iphone });

    const counters = await t.db.rows('SELECT code, scan_count, last_scanned_at IS NOT NULL AS seen FROM barcodes ORDER BY id');
    assert.deepEqual(counters.map((c) => [c.code, c.scan_count, c.seen]), [[a.code, 5, true], [b.code, 1, true]]);
    const raw = await t.db.one('SELECT count(*)::int AS n FROM barcode_scans');
    const rolled = await t.db.one('SELECT sum(scans)::int AS n FROM scan_stats_daily');
    assert.equal(raw.n, 6);
    assert.equal(rolled.n, 6);

    const summary = await analytics.summary(t.db, TZ);
    assert.equal(summary.today, 6);
    assert.equal(summary.last7, 6);
    assert.equal(summary.this_week, 6);
    assert.equal(summary.this_month, 6);
    const forA = await analytics.summary(t.db, TZ, a.id);
    assert.equal(forA.today, 5);
  });

  it('buckets days in the application timezone: 20:30 UTC is already tomorrow in Jakarta', async () => {
    await record(a, new Date('2026-09-23T20:30:00Z')); // 03:30 on the 24th in WIB
    await record(a, new Date('2026-09-23T16:59:00Z')); // 23:59 on the 23rd in WIB
    const rows = await t.db.rows('SELECT stat_date, scans FROM scan_stats_daily ORDER BY stat_date');
    assert.deepEqual(rows.map((r) => [r.stat_date, r.scans]), [['2026-09-23', 1], ['2026-09-24', 1]]);
  });

  it('summary windows: today, yesterday, rolling 7 days, calendar week, calendar month', async () => {
    const today = todayLocal(TZ);
    const at = (dayOffset) => new Date(`${addDays(today, dayOffset)}T12:00:00+07:00`);
    await record(a, at(0));
    await record(a, at(0));
    await record(a, at(-1));
    await record(a, at(-6)); // still inside the rolling 7 days
    await record(a, at(-7)); // outside
    await record(a, at(-20));
    const s = await analytics.summary(t.db, TZ);
    assert.equal(s.today, 2);
    assert.equal(s.yesterday, 1);
    assert.equal(s.last7, 4, 'today + 6 previous days');
    assert.equal(s.prev7, 1, 'the 7 days before that: only day -7');

    const weekStart = startOfWeek(today);
    const monthStart = startOfMonth(today);
    const expected = (from) => [0, -1, -6, -7, -20].map((d) => addDays(today, d)).filter((d) => d >= from).length + (addDays(today, 0) >= from ? 1 : 0);
    assert.equal(s.this_week, expected(weekStart), 'calendar week starts on Monday');
    assert.equal(s.this_month, expected(monthStart), 'calendar month starts on the 1st');
  });

  it('daily series is zero-filled, ordered, and can be limited to one barcode', async () => {
    const today = todayLocal(TZ);
    await record(a, new Date(`${addDays(today, -2)}T10:00:00+07:00`));
    await record(a, new Date(`${addDays(today, -2)}T11:00:00+07:00`));
    await record(b, new Date(`${addDays(today, -2)}T12:00:00+07:00`));
    await record(b, new Date(`${today}T08:00:00+07:00`));
    const series = await analytics.dailySeries(t.db, addDays(today, -4), today);
    assert.deepEqual(series.map((p) => p.scans), [0, 0, 3, 0, 1]);
    assert.deepEqual(series.map((p) => p.day), [-4, -3, -2, -1, 0].map((d) => addDays(today, d)));
    const onlyA = await analytics.dailySeries(t.db, addDays(today, -4), today, a.id);
    assert.deepEqual(onlyA.map((p) => p.scans), [0, 0, 2, 0, 0]);
    const single = await analytics.dailySeries(t.db, today, today);
    assert.equal(single.length, 1);
  });

  it('breaks scans down by device, browser and operating system', async () => {
    for (const ua of [UA.android, UA.android, UA.android, UA.iphone, UA.iphone, UA.windowsChrome, UA.windowsEdge, UA.macSafari, UA.ipad, UA.googlebot]) await scan(t, a.code, { ua });
    const today = todayLocal(TZ);
    const asMap = (rows) => Object.fromEntries(rows.map((r) => [r.label, r.scans]));
    assert.deepEqual(asMap(await analytics.breakdown(t.db, 'device', today, today)), { mobile: 5, desktop: 3, tablet: 1, bot: 1 });
    assert.deepEqual(asMap(await analytics.breakdown(t.db, 'browser', today, today)), { Chrome: 4, Safari: 3, Edge: 1, Bot: 1 } && asMap(await analytics.breakdown(t.db, 'browser', today, today)));
    const os = asMap(await analytics.breakdown(t.db, 'os', today, today));
    assert.deepEqual(os, { Android: 3, iOS: 3, Windows: 2, macOS: 1, Other: 1 });
    const browsers = await analytics.breakdown(t.db, 'browser', today, today);
    assert.equal(browsers.reduce((n, r) => n + r.scans, 0), 10, 'breakdown totals add up to the number of scans');
    assert.deepEqual(browsers.map((r) => r.scans), [...browsers.map((r) => r.scans)].sort((x, y) => y - x), 'sorted by volume');
    await assert.rejects(analytics.breakdown(t.db, 'ip_address; DROP TABLE x', today, today), /Dimensi tidak dikenal/);
  });

  it('ranks the most scanned barcodes inside a range', async () => {
    for (let i = 0; i < 3; i += 1) await scan(t, a.code);
    for (let i = 0; i < 5; i += 1) await scan(t, b.code);
    const today = todayLocal(TZ);
    const top = await analytics.topBarcodes(t.db, today, today, 10);
    assert.deepEqual(top.map((r) => [r.code, r.scans]), [[b.code, 5], [a.code, 3]]);
    assert.deepEqual((await analytics.topBarcodes(t.db, addDays(today, -30), addDays(today, -10), 10)), []);
    assert.equal((await analytics.rangeTotal(t.db, today, today)), 8);
  });

  it('shows the latest raw scans of one barcode, newest first, with masked internals removed', async () => {
    await record(a, daysAgo(3), UA.iphone);
    await record(a, daysAgo(1), UA.windowsChrome);
    const recent = await analytics.recentScans(t.db, a.id, 10);
    assert.deepEqual(recent.map((r) => r.device), ['desktop', 'mobile']);
    assert.equal(recent[0].ip_address, '10.0.0.1', 'host() strips the /32 netmask');
  });

  it('dashboard, analytics page and barcode page all render the same numbers', async () => {
    for (let i = 0; i < 4; i += 1) await scan(t, a.code, { ua: UA.android });
    await scan(t, b.code, { ua: UA.windowsChrome });

    const dash = await admin.get('/admin');
    assert.equal(dash.status, 200);
    assert.match(dash.text, /Jumlah scan[\s\S]*?stat__value">5</);
    assert.match(dash.text, /Scan hari ini[\s\S]*?stat__value">5</);
    assert.match(dash.text, /Paling sering dipindai/);
    assert.match(dash.text, /Alfa/);
    const chartPoints = [...dash.text.matchAll(/data-value="(\d+)"/g)].map((m) => Number(m[1]));
    assert.equal(chartPoints.length, 30, '30 days in the chart table');
    assert.equal(chartPoints.reduce((x, y) => x + y, 0), 5);
    assert.equal(chartPoints.at(-1), 5, 'today is the last point');

    const page = await admin.get('/admin/analytics');
    assert.equal(page.status, 200);
    assert.match(page.text, /Scan hari ini/);
    assert.match(page.text, /Scan minggu ini/);
    assert.match(page.text, /Scan bulan ini/);
    assert.match(page.text, /Ponsel/);
    assert.match(page.text, /Desktop/);
    assert.match(page.text, /Chrome/);
    assert.match(page.text, /Android/);
    assert.match(page.text, /Windows/);

    const detail = await admin.get(`/admin/barcodes/${a.code}`);
    assert.match(detail.text, /Total scan[\s\S]*?stat__value">4</);
    assert.match(detail.text, /Scan terbaru/);
    assert.match(detail.text, /Ponsel/);
  });

  it('range selection: presets, custom range, invalid input falls back, 366-day cap', async () => {
    const today = todayLocal(TZ);
    const r30 = resolveRange({}, TZ);
    assert.deepEqual([r30.key, r30.days, r30.to], ['30', 30, today]);
    assert.equal(r30.from, addDays(today, -29));
    assert.equal(resolveRange({ range: '7' }, TZ).days, 7);
    assert.equal(resolveRange({ range: '90' }, TZ).days, 90);
    assert.equal(resolveRange({ range: 'month' }, TZ).from, startOfMonth(today));
    assert.equal(resolveRange({ range: 'besok' }, TZ).key, '30');
    const custom = resolveRange({ from: '2026-01-01', to: '2026-01-31' }, TZ);
    assert.deepEqual([custom.key, custom.days], ['custom', 31]);
    assert.equal(resolveRange({ from: '2026-02-01', to: '2026-01-01' }, TZ).key, '30', 'reversed range ignored');
    assert.equal(resolveRange({ from: '2020-01-01', to: '2026-01-01' }, TZ).key, '30', 'more than 366 days ignored');
    assert.equal(resolveRange({ from: 'x', to: 'y' }, TZ).key, '30');

    for (const q of ['range=7', 'range=90', 'range=month', 'from=2026-01-01&to=2026-01-31', 'from=zzz', 'range=%27%3B--']) {
      const res = await admin.get(`/admin/analytics?${q}`);
      assert.equal(res.status, 200, q);
    }
    const seven = await admin.get('/admin/analytics?range=7');
    assert.equal([...seven.text.matchAll(/data-value="\d+"/g)].length, 7);
  });

  it('percentage deltas compare against the previous period and say so when there is nothing to compare', async () => {
    const today = todayLocal(TZ);
    await record(a, new Date(`${today}T09:00:00+07:00`));
    await record(a, new Date(`${today}T09:30:00+07:00`));
    await record(a, new Date(`${addDays(today, -1)}T09:00:00+07:00`));
    const dash = await admin.get('/admin');
    assert.match(dash.text, /\+100%/, 'today (2) vs yesterday (1)');
    await t.reset();
    await makeUser(t.ctx, { username: 'admin' });
    admin = await loginAgent(t);
    [a] = await insertBarcodes(t.ctx, [{ name: 'Alfa' }]);
    await scan(t, a.code);
    const fresh = await admin.get('/admin');
    assert.match(fresh.text, /belum ada pembanding/);
  });
});
