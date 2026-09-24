import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { parseCsv } from '../../src/lib/csv.js';
import { csrfFor, insertBarcodes, loginAgent, makeUser, postForm, scan, startApp } from '../helpers/app.js';

describe('bulk actions', () => {
  let t;
  let admin;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await makeUser(t.ctx, { username: 'admin' });
    admin = await loginAgent(t);
    await insertBarcodes(t.ctx, Array.from({ length: 60 }, (_, i) => ({ name: i < 30 ? `Kopi ${i}` : `Teh ${i}`, targetUrl: `https://example.com/${i}` })));
  });

  const bulk = (fields) => postForm(admin, '/admin/barcodes/bulk', { return_to: '/admin/barcodes?page=2', ...fields }, { tokenPage: '/admin/barcodes' });
  const statusCounts = async () => {
    const rows = await t.db.rows('SELECT status, count(*)::int AS n FROM barcodes GROUP BY status');
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  };
  const flashOf = async () => (await admin.get('/admin/barcodes')).text;

  it('deactivates and reactivates a selection, returning to where the admin was', async () => {
    const res = await bulk({ action: 'deactivate', ids: ['1', '2', '3'] });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/barcodes?page=2');
    assert.deepEqual(await statusCounts(), { active: 57, inactive: 3 });
    assert.match(await flashOf(), /3 barcode berhasil dinonaktifkan/);

    await bulk({ action: 'activate', ids: ['1', '2'] });
    assert.deepEqual(await statusCounts(), { active: 59, inactive: 1 });
    assert.match(await flashOf(), /2 barcode berhasil diaktifkan/);
  });

  it('only counts rows that actually changed', async () => {
    await bulk({ action: 'deactivate', ids: ['1'] });
    await bulk({ action: 'deactivate', ids: ['1', '2', '3'] });
    assert.match(await flashOf(), /2 barcode berhasil dinonaktifkan/, 'barcode 1 was already inactive');
  });

  it('deletes exactly the selected barcodes (with their scans) and nothing else', async () => {
    await t.db.query("INSERT INTO barcode_scans (barcode_id, device, browser, operating_system) SELECT id, 'mobile', 'Chrome', 'Android' FROM barcodes WHERE id IN (1, 2, 30)");
    const res = await bulk({ action: 'delete', ids: ['1', '2', '3'] });
    assert.equal(res.status, 302);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 57);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes WHERE id IN (1,2,3)')).n, 0);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_scans')).n, 1, 'scans of deleted barcodes are gone, the other one stays');
    assert.match(await flashOf(), /3 barcode berhasil dihapus/);
  });

  it('applies to EVERY result of the current filter with "select all", not just the visible page', async () => {
    const res = await bulk({ action: 'deactivate', select_all_matching: '1', q: 'kopi' });
    assert.equal(res.status, 302);
    const kopi = await t.db.one("SELECT count(*) FILTER (WHERE status = 'inactive')::int AS off, count(*)::int AS n FROM barcodes WHERE name LIKE 'Kopi%'");
    assert.deepEqual({ ...kopi }, { off: 30, n: 30 }, 'all 30 matches, although a page shows 25');
    const teh = await t.db.one("SELECT count(*) FILTER (WHERE status = 'inactive')::int AS off FROM barcodes WHERE name LIKE 'Teh%'");
    assert.equal(teh.off, 0, 'non-matching rows untouched');
    assert.match(await flashOf(), /30 barcode berhasil dinonaktifkan/);

    await bulk({ action: 'delete', select_all_matching: '1', status: 'inactive' });
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 30);
  });

  it('select-all honours search, status and date filters together', async () => {
    await t.db.query("UPDATE barcodes SET status = 'inactive' WHERE id <= 10");
    await bulk({ action: 'activate', select_all_matching: '1', status: 'inactive', q: 'Kopi' });
    assert.deepEqual(await statusCounts(), { active: 60 });
    await t.db.query("UPDATE barcodes SET created_at = '2001-05-05 12:00:00+07' WHERE id <= 5");
    await bulk({ action: 'delete', select_all_matching: '1', from: '2001-05-05', to: '2001-05-05' });
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 55);
  });

  it('refuses to wipe everything unless the person typed HAPUS', async () => {
    let res = await bulk({ action: 'delete', select_all_matching: '1' });
    assert.equal(res.status, 302);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 60);
    assert.match(await flashOf(), /ketik HAPUS/);

    res = await bulk({ action: 'delete', select_all_matching: '1', confirm_text: 'hapus' });
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 60, 'case matters');

    res = await bulk({ action: 'delete', select_all_matching: '1', confirm_text: 'HAPUS' });
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
  });

  it('validates the request: unknown action, empty selection, garbage ids, oversized selection', async () => {
    await bulk({ action: 'format-disk', ids: ['1'] });
    assert.match(await flashOf(), /Aksi massal tidak dikenal/);
    await bulk({ action: 'delete' });
    assert.match(await flashOf(), /Pilih minimal satu barcode/);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 60);

    await bulk({ action: 'deactivate', ids: ['abc', '-5', '0', '1.5e3', "1; DROP TABLE barcodes", '4', '4'] });
    assert.deepEqual(await statusCounts(), { active: 59, inactive: 1 }, 'only the valid, de-duplicated id 4 (and the parsable "1") ... ');
  });

  it('rejects an oversized explicit selection', async () => {
    const ids = Array.from({ length: 5001 }, (_, i) => String(i + 1));
    await bulk({ action: 'deactivate', ids });
    assert.match(await flashOf(), /Maksimal 5000 barcode per aksi/);
    assert.deepEqual(await statusCounts(), { active: 60 });
  });

  it('exports only the selection, or every result of the filter', async () => {
    const one = await bulk({ action: 'export', ids: ['2', '3'] });
    assert.equal(one.status, 200);
    assert.match(one.headers['content-type'], /text\/csv/);
    assert.deepEqual(parseCsv(one.text).rows.map((r) => r.data.code), ['BR-000002', 'BR-000003']);

    const filtered = await bulk({ action: 'export', select_all_matching: '1', q: 'teh' });
    assert.equal(parseCsv(filtered.text).rows.length, 30);

    const none = await bulk({ action: 'export' });
    assert.equal(none.status, 302, 'nothing selected -> back to the list with a message');
  });

  it('requires a CSRF token and an authenticated writer', async () => {
    const noToken = await admin.post('/admin/barcodes/bulk').type('form').send({ action: 'delete', ids: ['1'] });
    assert.equal(noToken.status, 403);
    const anonymous = await t.request().post('/admin/barcodes/bulk').type('form').send({ action: 'delete', ids: ['1'] });
    assert.equal(anonymous.status, 403, 'no session, no token');
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 60);
    const token = await csrfFor(admin, '/admin/barcodes');
    const ok = await admin.post('/admin/barcodes/bulk').type('form').send({ _csrf: token, action: 'deactivate', ids: ['1'] });
    assert.equal(ok.status, 302);
  });

  it('a bulk status change takes effect on the redirect endpoint immediately, even with the cache on', async () => {
    const cached = await startApp({ REDIRECT_CACHE_TTL_MS: '60000' });
    try {
      await makeUser(cached.ctx, { username: 'admin' });
      const agent = await loginAgent(cached);
      await insertBarcodes(cached.ctx, [{ targetUrl: 'https://example.com/a' }, { targetUrl: 'https://example.com/b' }]);
      assert.equal((await scan(cached, 'BR-000001')).status, 302);
      assert.equal((await scan(cached, 'BR-000002')).status, 302);
      await postForm(agent, '/admin/barcodes/bulk', { action: 'deactivate', ids: ['1', '2'] }, { tokenPage: '/admin/barcodes' });
      assert.equal((await scan(cached, 'BR-000001')).status, 403);
      assert.equal((await scan(cached, 'BR-000002')).status, 403);
      await postForm(agent, '/admin/barcodes/bulk', { action: 'delete', ids: ['1'] }, { tokenPage: '/admin/barcodes' });
      assert.equal((await scan(cached, 'BR-000001')).status, 404);
    } finally {
      await cached.close();
    }
  });
});
