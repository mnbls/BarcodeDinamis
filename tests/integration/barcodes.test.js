import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { binaryParser, csrfFor, insertBarcodes, loginAgent, makeUser, postForm, startApp } from '../helpers/app.js';

describe('barcode CRUD', () => {
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
  });

  const create = (fields = {}) =>
    postForm(admin, '/admin/barcodes', { name: 'Barcode Produk A', description: 'Stiker kemasan', target_type: 'url', target_value: 'https://contoh.com/produk-a', status: 'active', ...fields }, { tokenPage: '/admin/barcodes/new' });

  it('creates a barcode: unique BR-000001 code, stored row, redirect to the detail page with QR', async () => {
    const res = await create();
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/barcodes/BR-000001');

    const row = await t.db.one('SELECT * FROM barcodes WHERE code = $1', ['BR-000001']);
    assert.equal(row.name, 'Barcode Produk A');
    assert.equal(row.description, 'Stiker kemasan');
    assert.equal(row.target_url, 'https://contoh.com/produk-a');
    assert.equal(row.status, 'active');
    assert.equal(row.scan_count, 0);
    assert.equal(row.expired_at, null);
    assert.ok(row.created_by, 'creator recorded');

    const detail = await admin.get(res.headers.location);
    assert.equal(detail.status, 200);
    assert.match(detail.text, /Barcode Produk A/);
    assert.match(detail.text, /https:\/\/barcode\.test\/b\/BR-000001/, 'shows the dynamic URL that the QR encodes');
    assert.match(detail.text, /\/admin\/barcodes\/BR-000001\/qr\.svg/);
    assert.match(detail.text, /Download PNG/);
    assert.match(detail.text, /Download SVG/);
    assert.match(detail.text, /Print/);
    assert.match(detail.text, /Edit Barcode/);
    assert.match(detail.text, /Nonaktifkan/);
    assert.match(detail.text, /Barcode berhasil dibuat/, 'toast payload after redirect');
  });

  it('assigns sequential codes and never reuses one, even after a delete', async () => {
    const a = await create({ name: 'A' });
    const b = await create({ name: 'B' });
    assert.deepEqual([a.headers.location, b.headers.location], ['/admin/barcodes/BR-000001', '/admin/barcodes/BR-000002']);
    await postForm(admin, '/admin/barcodes/BR-000002/delete', {}, { tokenPage: '/admin/barcodes/BR-000001' });
    const c = await create({ name: 'C' });
    assert.equal(c.headers.location, '/admin/barcodes/BR-000003', 'BR-000002 must never be issued again');
  });

  it('validates the form and keeps what was typed', async () => {
    const res = await create({ name: '   ', target_value: 'javascript:alert(1)', description: 'x'.repeat(1001) });
    assert.equal(res.status, 422);
    assert.match(res.text, /Nama barcode wajib diisi/);
    assert.match(res.text, /URL harus diawali http/);
    assert.match(res.text, /Keterangan maksimal 1000 karakter/);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);

    const keeps = await create({ name: 'Tetap ada', target_value: 'ftp://x.test' });
    assert.match(keeps.text, /value="Tetap ada"/);
    assert.equal(keeps.status, 422);
  });

  it('rejects every dangerous destination on create AND on edit', async () => {
    for (const evil of ['javascript:alert(document.cookie)', 'data:text/html;base64,PHNjcmlwdD4=', 'file:///etc/passwd', 'vbscript:x', 'ftp://example.com']) {
      const res = await create({ target_value: evil });
      assert.equal(res.status, 422, evil);
    }
    await create();
    const res = await postForm(admin, '/admin/barcodes/BR-000001', { name: 'Barcode Produk A', target_type: 'url', target_value: 'javascript:alert(1)', status: 'active' }, { tokenPage: '/admin/barcodes/BR-000001/edit' });
    assert.equal(res.status, 422);
    const row = await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'");
    assert.equal(row.target_url, 'https://contoh.com/produk-a', 'unchanged');
  });

  it('the database itself refuses dangerous schemes (defence in depth)', async () => {
    await assert.rejects(
      t.db.query("INSERT INTO barcodes (code, name, target_url) VALUES ('BR-EVIL01', 'x', 'javascript:alert(1)')"),
      /barcodes_target_scheme_check/,
    );
    await assert.rejects(t.db.query("INSERT INTO barcodes (code, name, target_url) VALUES ('BR-EVIL02', 'x', 'data:text/html,x')"), /check/i);
  });

  it('supports WhatsApp, email and phone destinations', async () => {
    const wa = await create({ name: 'WA', target_type: 'whatsapp', target_value: '081234567890', target_extra: 'Halo!' });
    const mail = await create({ name: 'Mail', target_type: 'email', target_value: 'halo@contoh.co.id', target_extra: 'Tanya' });
    const tel = await create({ name: 'Tel', target_type: 'phone', target_value: '0274123456' });
    assert.equal(wa.status, 302);
    const rows = await t.db.rows('SELECT name, target_type, target_url FROM barcodes ORDER BY id');
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { name: 'WA', target_type: 'whatsapp', target_url: 'https://wa.me/6281234567890?text=Halo!' },
      { name: 'Mail', target_type: 'email', target_url: 'mailto:halo@contoh.co.id?subject=Tanya' },
      { name: 'Tel', target_type: 'phone', target_url: 'tel:+62274123456' },
    ]);
    assert.equal(mail.status, 302);
    assert.equal(tel.status, 302);

    const edit = await admin.get('/admin/barcodes/BR-000001/edit');
    assert.match(edit.text, /value="6281234567890"/, 'edit form is pre-filled from the stored URL');
    assert.match(edit.text, /value="Halo!"/);
  });

  it('stores an expiry given in local time (WIB) as the right instant, and only accepts the future', async () => {
    const res = await create({ expired_at: '2099-01-02T03:04' });
    assert.equal(res.status, 302);
    const row = await t.db.one("SELECT expired_at FROM barcodes WHERE code = 'BR-000001'");
    assert.equal(row.expired_at.toISOString(), '2099-01-01T20:04:00.000Z', '03:04 WIB on the 2nd = 20:04 UTC on the 1st');

    const past = await create({ expired_at: '2001-01-01T00:00' });
    assert.equal(past.status, 422);
    assert.match(past.text, /harus di masa depan/);
    const junk = await create({ expired_at: 'kapan-kapan' });
    assert.match(junk.text, /Tanggal kedaluwarsa tidak valid/);
  });

  it('EDIT: changing the URL keeps the code, writes history, updates updated_at', async () => {
    await create();
    const before = await t.db.one("SELECT id, code, created_at, updated_at FROM barcodes WHERE code = 'BR-000001'");
    await new Promise((r) => setTimeout(r, 15));
    const res = await postForm(admin, '/admin/barcodes/BR-000001', { name: 'Nama Baru', description: '', target_type: 'url', target_value: 'https://contoh.com/produk-b', status: 'active' }, { tokenPage: '/admin/barcodes/BR-000001/edit' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/barcodes/BR-000001');

    const after = await t.db.one("SELECT * FROM barcodes WHERE code = 'BR-000001'");
    assert.equal(after.id, before.id);
    assert.equal(after.code, 'BR-000001', 'the code never changes');
    assert.equal(after.name, 'Nama Baru');
    assert.equal(after.target_url, 'https://contoh.com/produk-b');
    assert.equal(after.description, null);
    assert.equal(after.created_at.getTime(), before.created_at.getTime());
    assert.ok(after.updated_at > before.updated_at);

    const history = await t.db.rows('SELECT h.old_url, h.new_url, u.username FROM barcode_history h JOIN users u ON u.id = h.changed_by');
    assert.equal(history.length, 1);
    assert.deepEqual({ ...history[0] }, { old_url: 'https://contoh.com/produk-a', new_url: 'https://contoh.com/produk-b', username: 'admin' });

    // A second change extends the chain A -> B -> C
    await postForm(admin, '/admin/barcodes/BR-000001', { name: 'Nama Baru', target_type: 'url', target_value: 'https://contoh.com/produk-c', status: 'active' }, { tokenPage: '/admin/barcodes/BR-000001/edit' });
    const chain = await t.db.rows('SELECT old_url, new_url FROM barcode_history ORDER BY id');
    assert.deepEqual(chain.map((r) => [r.old_url, r.new_url]), [
      ['https://contoh.com/produk-a', 'https://contoh.com/produk-b'],
      ['https://contoh.com/produk-b', 'https://contoh.com/produk-c'],
    ]);

    const page = await admin.get('/admin/barcodes/BR-000001');
    assert.match(page.text, /Riwayat perubahan tujuan/);
    assert.match(page.text, /produk-a/);
    assert.match(page.text, /produk-c/);
  });

  it('EDIT: no history row when only the name/status changes', async () => {
    await create();
    await postForm(admin, '/admin/barcodes/BR-000001', { name: 'Hanya nama', target_type: 'url', target_value: 'https://contoh.com/produk-a', status: 'inactive' }, { tokenPage: '/admin/barcodes/BR-000001/edit' });
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_history')).n, 0);
    const row = await t.db.one("SELECT name, status FROM barcodes WHERE code = 'BR-000001'");
    assert.deepEqual({ ...row }, { name: 'Hanya nama', status: 'inactive' });
  });

  it('EDIT: an untouched expiry keeps its exact stored value (seconds included)', async () => {
    const [{ id }] = await insertBarcodes(t.ctx, [{ name: 'Exp', expiredLocal: '2099-06-30 23:59:59' }]);
    const before = await t.db.one('SELECT expired_at FROM barcodes WHERE id = $1', [id]);
    const edit = await admin.get('/admin/barcodes/BR-000001/edit');
    assert.match(edit.text, /value="2099-06-30T23:59"/);
    await postForm(admin, '/admin/barcodes/BR-000001', { name: 'Exp 2', target_type: 'url', target_value: 'https://example.com/tujuan', status: 'active', expired_at: '2099-06-30T23:59' }, { tokenPage: '/admin/barcodes/BR-000001/edit' });
    const after = await t.db.one('SELECT expired_at FROM barcodes WHERE id = $1', [id]);
    assert.equal(after.expired_at.getTime(), before.expired_at.getTime());
  });

  it('EDIT: two concurrent edits both succeed and history stays a consistent chain', async () => {
    await create();
    const other = await loginAgent(t);
    const tokenA = await csrfFor(admin, '/admin/barcodes/BR-000001/edit');
    const tokenB = await csrfFor(other, '/admin/barcodes/BR-000001/edit');
    const send = (agent, token, url) => agent.post('/admin/barcodes/BR-000001').type('form').send({ _csrf: token, name: 'N', target_type: 'url', target_value: url, status: 'active' });
    const [r1, r2] = await Promise.all([send(admin, tokenA, 'https://contoh.com/x1'), send(other, tokenB, 'https://contoh.com/x2')]);
    assert.deepEqual([r1.status, r2.status], [302, 302]);
    const rows = await t.db.rows('SELECT old_url, new_url FROM barcode_history ORDER BY id');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].old_url, 'https://contoh.com/produk-a');
    assert.equal(rows[1].old_url, rows[0].new_url, 'the second edit started from the result of the first (row lock)');
  });

  it('toggles the status and deletes with confirmation-free POSTs guarded by CSRF', async () => {
    await create();
    let res = await postForm(admin, '/admin/barcodes/BR-000001/status', { status: 'inactive', return_to: '/admin/barcodes?status=active' }, { tokenPage: '/admin/barcodes' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/barcodes?status=active');
    assert.equal((await t.db.one("SELECT status FROM barcodes WHERE code = 'BR-000001'")).status, 'inactive');

    res = await postForm(admin, '/admin/barcodes/BR-000001/status', { status: 'active', return_to: 'https://evil.example.com' }, { tokenPage: '/admin/barcodes' });
    assert.equal(res.headers.location, '/admin/barcodes/BR-000001', 'return_to must be an internal admin path');
    assert.equal((await t.db.one("SELECT status FROM barcodes WHERE code = 'BR-000001'")).status, 'active');

    res = await postForm(admin, '/admin/barcodes/BR-000001/delete', {}, { tokenPage: '/admin/barcodes' });
    assert.equal(res.status, 302);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
    assert.equal((await admin.get('/admin/barcodes/BR-000001')).status, 404);
  });

  it('DELETE removes the scans, rollups and history of that barcode only', async () => {
    const [a, b] = await insertBarcodes(t.ctx, [{ name: 'A' }, { name: 'B' }]);
    for (const id of [a.id, b.id]) {
      await t.db.query("INSERT INTO barcode_scans (barcode_id, device, browser, operating_system) VALUES ($1, 'mobile', 'Chrome', 'Android')", [id]);
      await t.db.query("INSERT INTO scan_stats_daily (barcode_id, stat_date, device, browser, operating_system, scans) VALUES ($1, CURRENT_DATE, 'mobile', 'Chrome', 'Android', 1)", [id]);
      await t.db.query("INSERT INTO barcode_history (barcode_id, old_url, new_url) VALUES ($1, 'https://a.test', 'https://b.test')", [id]);
    }
    await postForm(admin, `/admin/barcodes/${a.code}/delete`, {}, { tokenPage: '/admin/barcodes' });
    for (const table of ['barcode_scans', 'scan_stats_daily', 'barcode_history']) {
      const rows = await t.db.rows(`SELECT barcode_id FROM ${table}`);
      assert.deepEqual(rows.map((r) => r.barcode_id), [b.id], table);
    }
  });

  it('returns 404 pages (not 500) for unknown, malformed or hostile codes', async () => {
    for (const path of ['/admin/barcodes/BR-999999', '/admin/barcodes/xx', '/admin/barcodes/BR-1;DROP', '/admin/barcodes/BR-999999/edit', '/admin/barcodes/BR-999999/qr.png', '/admin/barcodes/BR-999999/print']) {
      const res = await admin.get(path);
      assert.equal(res.status, 404, path);
    }
    const post = await postForm(admin, '/admin/barcodes/BR-999999/delete', {}, { tokenPage: '/admin' });
    assert.equal(post.status, 404);
  });

  it('QR endpoints: PNG/SVG content types, attachment names, print page', async () => {
    await create();
    const png = await admin.get('/admin/barcodes/BR-000001/qr.png').buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(png.status, 200);
    assert.equal(png.headers['content-type'], 'image/png');
    assert.equal(png.body.subarray(1, 4).toString(), 'PNG');
    assert.ok(!png.headers['content-disposition'], 'inline by default (used for previews)');

    const dl = await admin.get('/admin/barcodes/BR-000001/qr.svg?download=1').buffer(true).parse(binaryParser);
    assert.equal(dl.headers['content-type'], 'image/svg+xml; charset=utf-8');
    assert.equal(dl.headers['content-disposition'], 'attachment; filename="BR-000001.svg"');
    assert.match(dl.body.toString(), /<svg/);

    const dlPng = await admin.get('/admin/barcodes/BR-000001/qr.png?download=1');
    assert.equal(dlPng.headers['content-disposition'], 'attachment; filename="BR-000001.png"');

    const print = await admin.get('/admin/barcodes/BR-000001/print');
    assert.equal(print.status, 200);
    assert.match(print.text, /data-print/);
    assert.match(print.text, /BR-000001/);
    assert.match(print.text, /https:\/\/barcode\.test\/b\/BR-000001/);
  });

  it('escapes hostile text everywhere it is displayed (XSS)', async () => {
    const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    await create({ name: payload, description: payload });
    for (const path of ['/admin/barcodes', '/admin/barcodes/BR-000001', '/admin/barcodes/BR-000001/edit', '/admin/barcodes/BR-000001/print', '/admin']) {
      const res = await admin.get(path);
      assert.equal(res.status, 200, path);
      assert.ok(!res.text.includes('<script>alert("xss")'), `${path}: raw script tag must not appear`);
      assert.ok(!res.text.includes('<img src=x'), `${path}: raw img tag must not appear`);
    }
    const list = await admin.get('/admin/barcodes');
    assert.match(list.text, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
  });
});

describe('list, search, filter, sort, pagination', () => {
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
    const rows = Array.from({ length: 60 }, (_, i) => ({
      name: i % 5 === 0 ? `Kopi Nusantara ${i}` : `Produk ${String(i).padStart(2, '0')}`,
      targetUrl: `https://example.com/p/${i}`,
      status: i % 10 === 3 ? 'inactive' : 'active',
      expiredLocal: i % 10 === 7 ? '2001-01-01 00:00:00' : null,
    }));
    await insertBarcodes(t.ctx, rows);
    await t.db.query("UPDATE barcodes SET scan_count = id * 3, created_at = now() - (id * interval '1 day')");
  });

  const codesOf = (html) => [...html.matchAll(/class="code-link" href="\/admin\/barcodes\/(BR-\d+)"/g)].map((m) => m[1]);

  it('paginates: 25 per page by default, correct page counts and links', async () => {
    const p1 = await admin.get('/admin/barcodes');
    assert.equal(codesOf(p1.text).length, 25);
    assert.match(p1.text, /1-25 dari 60/);
    const p3 = await admin.get('/admin/barcodes?page=3');
    assert.equal(codesOf(p3.text).length, 10);
    assert.match(p3.text, /51-60 dari 60/);
    const p99 = await admin.get('/admin/barcodes?page=99');
    assert.match(p99.text, /51-60 dari 60/, 'a page beyond the end shows the last page');
    const per100 = await admin.get('/admin/barcodes?per_page=100');
    assert.equal(codesOf(per100.text).length, 60);
    const bogus = await admin.get('/admin/barcodes?per_page=999999&page=-4');
    assert.equal(bogus.status, 200);
    assert.equal(codesOf(bogus.text).length, 25, 'invalid per_page falls back to the default');
  });

  it('searches by code, by name and by target URL (case-insensitive, partial)', async () => {
    const byName = await admin.get('/admin/barcodes?q=kopi');
    assert.equal(codesOf(byName.text).length, 12);
    const byCode = await admin.get('/admin/barcodes?q=BR-000042');
    assert.deepEqual(codesOf(byCode.text), ['BR-000042']);
    const byPartialCode = await admin.get('/admin/barcodes?q=br-00005');
    assert.equal(codesOf(byPartialCode.text).length, 10);
    const byUrl = await admin.get('/admin/barcodes?q=example.com/p/17');
    assert.deepEqual(codesOf(byUrl.text), ['BR-000018']);
    const none = await admin.get('/admin/barcodes?q=tidak-ada-yang-cocok');
    assert.match(none.text, /Tidak ada barcode yang cocok/);
  });

  it('treats % and _ in the search box literally (no wildcard surprises)', async () => {
    await insertBarcodes(t.ctx, [{ name: 'Diskon 50% Lebaran', targetUrl: 'https://example.com/diskon' }, { name: 'Diskon 50X Lebaran', targetUrl: 'https://example.com/diskon2' }]);
    const res = await admin.get(`/admin/barcodes?q=${encodeURIComponent('50%')}`);
    const codes = codesOf(res.text);
    assert.equal(codes.length, 1);
    const wildcard = await admin.get(`/admin/barcodes?q=${encodeURIComponent('%')}`);
    assert.equal(codesOf(wildcard.text).length, 1, '"%" matches only names containing a literal percent sign');
    const under = await admin.get(`/admin/barcodes?q=${encodeURIComponent('Produk_0')}`);
    assert.match(under.text, /Tidak ada barcode yang cocok/, '"_" must not match any single character');
  });

  it('filters by status: active / inactive / expired are disjoint and add up', async () => {
    const count = async (status) => codesOf((await admin.get(`/admin/barcodes?status=${status}&per_page=100`)).text).length;
    const [active, inactive, expired] = [await count('active'), await count('inactive'), await count('expired')];
    assert.equal(inactive, 6);
    assert.equal(expired, 6);
    assert.equal(active + inactive + expired, 60);
    const stats = await t.db.one('SELECT count(*) FILTER (WHERE status = $1)::int AS n FROM barcodes', ['inactive']);
    assert.equal(stats.n, inactive);
  });

  it('filters by creation date range (interpreted in the app timezone)', async () => {
    const day = (n) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
    const res = await admin.get(`/admin/barcodes?from=${day(10)}&to=${day(5)}&per_page=100`);
    assert.equal(codesOf(res.text).length, 6, 'days 5..10 ago inclusive');
    const only = await admin.get(`/admin/barcodes?from=${day(3)}&per_page=100`);
    assert.equal(codesOf(only.text).length, 3);
    const invalid = await admin.get('/admin/barcodes?from=bukan-tanggal&to=2026-99-99');
    assert.equal(invalid.status, 200);
    assert.equal(codesOf(invalid.text).length, 25, 'invalid dates are ignored');
  });

  it('sorts by every allowed column, both directions, with a stable tie-breaker', async () => {
    const first = async (q) => codesOf((await admin.get(`/admin/barcodes?${q}`)).text)[0];
    assert.equal(await first('sort=code&dir=asc'), 'BR-000001');
    assert.equal(await first('sort=code&dir=desc'), 'BR-000060');
    assert.equal(await first('sort=scan_count&dir=desc'), 'BR-000060');
    assert.equal(await first('sort=scan_count&dir=asc'), 'BR-000001');
    assert.equal(await first('sort=created_at&dir=desc'), 'BR-000001', 'newest created_at belongs to id 1 in this fixture');
    assert.equal(await first('sort=name&dir=asc'), 'BR-000001', 'name asc: "Kopi Nusantara 0" comes first');
    for (const sort of ['code', 'name', 'status', 'scan_count', 'created_at', 'updated_at', 'expired_at', 'last_scanned_at']) {
      for (const dir of ['asc', 'desc']) {
        const res = await admin.get(`/admin/barcodes?sort=${sort}&dir=${dir}`);
        assert.equal(res.status, 200, `${sort} ${dir}`);
        assert.equal(codesOf(res.text).length, 25);
      }
    }
  });

  it('is immune to SQL injection through every query parameter', async () => {
    const evil = ["' OR '1'='1", "'; DROP TABLE barcodes; --", '1; SELECT pg_sleep(5)', '" OR ""="', 'constructor', '__proto__', 'code); DELETE FROM barcodes; --'];
    for (const value of evil) {
      for (const param of ['q', 'status', 'sort', 'dir', 'from', 'to', 'page', 'per_page', 'batch']) {
        const res = await admin.get(`/admin/barcodes?${param}=${encodeURIComponent(value)}`);
        assert.ok([200, 302].includes(res.status), `${param}=${value} -> ${res.status}`);
      }
    }
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 60, 'all rows still there');
    const or = await admin.get(`/admin/barcodes?q=${encodeURIComponent("' OR '1'='1")}`);
    assert.match(or.text, /Tidak ada barcode yang cocok/, 'the injected OR did not widen the result');
  });

  it('shows Aktif / Nonaktif / Kedaluwarsa badges', async () => {
    const res = await admin.get('/admin/barcodes?per_page=100');
    assert.match(res.text, /badge--green[^>]*>.*?Aktif/s);
    assert.match(res.text, /badge--red[^>]*>.*?Nonaktif/s);
    assert.match(res.text, /badge--yellow[^>]*>.*?Kedaluwarsa/s);
  });
});
