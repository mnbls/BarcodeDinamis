import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CSV_BOM, parseCsv } from '../../src/lib/csv.js';
import { csrfFor, insertBarcodes, loginAgent, makeUser, startApp, uploadCsv } from '../helpers/app.js';

const bodyOf = (res) => res.text.replace(CSV_BOM, '');

describe('CSV import', () => {
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

  it('imports valid rows with generated codes and reports the failed rows with reasons', async () => {
    const csv = [
      'name,description,target_url,status',
      'Produk A,Produk pertama,https://example.com/a,active',
      'Produk B,Produk kedua,https://example.com/b,active',
      'Produk C,,https://example.com/c,inactive',
      ',Tanpa nama,https://example.com/d,active',
      'Produk E,Skema berbahaya,javascript:alert(1),active',
      'Produk F,Status aneh,https://example.com/f,mungkin',
      `${'X'.repeat(151)},Nama kepanjangan,https://example.com/g,active`,
      'Produk H,URL relatif,/halaman/h,active',
      'Produk I,Kedaluwarsa lampau,https://example.com/i,active,',
    ].join('\n');

    const res = await uploadCsv(admin, csv);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/admin\/import\/\d+$/);

    const rows = await t.db.rows('SELECT code, name, description, target_url, status, import_batch_id, created_by FROM barcodes ORDER BY id');
    assert.deepEqual(rows.map((r) => [r.code, r.name, r.status]), [
      ['BR-000001', 'Produk A', 'active'],
      ['BR-000002', 'Produk B', 'active'],
      ['BR-000003', 'Produk C', 'inactive'],
      ['BR-000004', 'Produk I', 'active'],
    ]);
    assert.equal(rows[0].description, 'Produk pertama');
    assert.equal(rows[2].description, null);
    assert.ok(rows.every((r) => r.import_batch_id && r.created_by));

    const batch = await t.db.one('SELECT * FROM import_batches');
    assert.deepEqual([batch.total_rows, batch.success_count, batch.failed_count], [9, 4, 5]);
    assert.equal(batch.first_code, 'BR-000001');
    assert.equal(batch.last_code, 'BR-000004');
    const failures = batch.errors.map((e) => [e.row, e.reason]);
    assert.deepEqual(failures.map((f) => f[0]), [5, 6, 7, 8, 9], 'row numbers follow the spreadsheet (header = row 1)');
    assert.match(failures[0][1], /Nama barcode wajib diisi/);
    assert.match(failures[1][1], /http:\/\/ atau https:\/\//, 'javascript: is refused');
    assert.match(failures[2][1], /Status harus active\/inactive/);
    assert.match(failures[3][1], /Nama maksimal 150 karakter/);
    assert.match(failures[4][1], /http:\/\/ atau https:\/\//, 'relative URLs are refused');

    const page = await admin.get(res.headers.location);
    assert.equal(page.status, 200);
    assert.match(page.text, /Hasil import #\d+/);
    assert.match(page.text, /BR-000001/);
    assert.match(page.text, /Nama barcode wajib diisi/);
    assert.match(page.text, /Baris yang gagal \(5\)/);
  });

  it('understands semicolon files, BOM, Indonesian headers, aktif/nonaktif and date-only expiry', async () => {
    const csv = `${CSV_BOM}Nama;Keterangan;URL Tujuan;Status;Kedaluwarsa\r\nSate Pak Slamet;Menu meja;https://example.com/sate;aktif;31-12-2099\r\nBakso;Stiker;https://example.com/bakso;Nonaktif;\r\n`;
    const res = await uploadCsv(admin, csv, { filename: 'menu excel.csv' });
    assert.equal(res.status, 302);
    const rows = await t.db.rows('SELECT name, status, expired_at FROM barcodes ORDER BY id');
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[0].name, rows[0].status, rows[1].status], ['Sate Pak Slamet', 'active', 'inactive']);
    assert.equal(rows[0].expired_at.toISOString(), '2099-12-31T16:59:59.000Z', 'date-only = end of that day in WIB');
    assert.equal(rows[1].expired_at, null);
    assert.equal((await t.db.one('SELECT filename FROM import_batches')).filename, 'menu excel.csv');
  });

  it('rejects files without the required columns, and never half-creates a batch', async () => {
    const res = await uploadCsv(admin, 'foo,bar\nA,https://x.test');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/import');
    const page = await admin.get('/admin/import');
    assert.match(page.text, /Kolom wajib tidak ditemukan: name, target_url/);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM import_batches')).n, 0);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
  });

  it('rejects empty files, header-only files, wrong extensions and binary uploads', async () => {
    for (const [content, filename, expected] of [
      ['', 'kosong.csv', /Pilih file CSV/],
      ['name,target_url\n', 'header.csv', /tidak berisi baris data/],
      ['name,target_url\nA,https://x.test', 'data.xlsx', /Format file harus \.csv/],
      [Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), 'zip.csv', /biner/],
    ]) {
      const res = await uploadCsv(admin, content, { filename });
      assert.equal(res.status, 302, filename);
      const page = await admin.get('/admin/import');
      assert.match(page.text, expected, filename);
    }
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
  });

  it('enforces the row limit and the upload size limit', async () => {
    const limited = await startApp({ IMPORT_MAX_ROWS: '3', IMPORT_MAX_UPLOAD_MB: '1' });
    try {
      await makeUser(limited.ctx, { username: 'admin' });
      const agent = await loginAgent(limited);
      const four = 'name,target_url\n' + [1, 2, 3, 4].map((i) => `P${i},https://x.test/${i}`).join('\n');
      const res = await uploadCsv(agent, four);
      assert.equal(res.status, 302);
      assert.match((await agent.get('/admin/import')).text, /batas per import adalah 3 baris/);

      const huge = `name,target_url\n${'A,https://x.test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'.repeat(30000)}`;
      assert.ok(huge.length > 1024 * 1024);
      const tooBig = await uploadCsv(agent, huge);
      assert.equal(tooBig.status, 413);
      assert.match(tooBig.text, /File terlalu besar/);
      assert.equal((await limited.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
    } finally {
      await limited.close();
    }
  });

  it('imports 2.500 rows in one go (batched inserts), keeping codes contiguous', async () => {
    const lines = ['name,target_url,status'];
    for (let i = 1; i <= 2500; i += 1) lines.push(`Barang ${i},https://example.com/barang/${i},${i % 7 === 0 ? 'inactive' : 'active'}`);
    lines.splice(1200, 0, 'Rusak,gopher://x,active');
    const started = Date.now();
    const res = await uploadCsv(admin, lines.join('\n'));
    assert.equal(res.status, 302);
    assert.ok(Date.now() - started < 20000, 'import must be fast');
    const stats = await t.db.one("SELECT count(*)::int AS n, min(code) AS lo, max(code) AS hi, count(*) FILTER (WHERE status = 'inactive')::int AS inactive FROM barcodes");
    assert.deepEqual({ ...stats }, { n: 2500, lo: 'BR-000001', hi: 'BR-002500', inactive: 357 });
    const batch = await t.db.one('SELECT * FROM import_batches');
    assert.deepEqual([batch.total_rows, batch.success_count, batch.failed_count, batch.errors[0].row], [2501, 2500, 1, 1201]);
  });

  it('a failing chunk rolls the whole import back (all-or-nothing for valid rows)', async () => {
    await t.db.query("ALTER TABLE barcodes ADD CONSTRAINT boom CHECK (name <> 'MELEDAK')");
    try {
      const res = await uploadCsv(admin, 'name,target_url\nAman,https://x.test/1\nMELEDAK,https://x.test/2');
      assert.equal(res.status, 500);
      assert.ok(!/boom|constraint|violates|postgres/i.test(res.text), 'no database details leak');
      assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
      assert.equal((await t.db.one('SELECT count(*)::int AS n FROM import_batches')).n, 0);
    } finally {
      await t.db.query('ALTER TABLE barcodes DROP CONSTRAINT boom');
    }
  });

  it('downloads the failed rows as CSV and lists/filters/exports the imported barcodes', async () => {
    const res = await uploadCsv(admin, 'name,target_url\nBagus,https://x.test/1\n,https://x.test/2\nJelek,javascript:1');
    const batchId = res.headers.location.split('/').pop();

    const errors = await admin.get(`/admin/import/${batchId}/errors.csv`);
    assert.equal(errors.status, 200);
    assert.match(errors.headers['content-type'], /text\/csv/);
    assert.match(errors.headers['content-disposition'], /import-\d+-baris-gagal\.csv/);
    const parsed = parseCsv(errors.text);
    assert.deepEqual(parsed.headers, ['row', 'reason', 'name', 'description', 'target_url', 'status', 'expired_at']);
    assert.deepEqual(parsed.rows.map((r) => r.data.row), ['3', '4']);
    assert.match(parsed.rows[1].data.reason, /http/);

    const list = await admin.get(`/admin/barcodes?batch=${batchId}`);
    assert.match(list.text, /Hasil import #\d+/);
    assert.match(list.text, /BR-000001/);
    assert.match(list.text, /1 barcode cocok dengan filter/);

    const exported = await admin.get(`/admin/barcodes/export.csv?batch=${batchId}`);
    assert.equal(parseCsv(exported.text).rows.length, 1);

    const unknown = await admin.get('/admin/import/99999');
    assert.equal(unknown.status, 404);
    assert.equal((await admin.get('/admin/import/abc')).status, 404);
  });

  it('template download is itself a valid import file', async () => {
    const tpl = await admin.get('/admin/import/template.csv');
    assert.equal(tpl.status, 200);
    assert.match(tpl.headers['content-disposition'], /template-import-barcode\.csv/);
    const res = await uploadCsv(admin, tpl.text);
    assert.equal(res.status, 302);
    const batch = await t.db.one('SELECT success_count, failed_count FROM import_batches');
    assert.deepEqual([batch.success_count, batch.failed_count], [3, 0]);
  });

  it('is protected: CSRF token required for the multipart upload, viewers are forbidden, anonymous users redirected', async () => {
    const noToken = await admin.post('/admin/import').attach('file', Buffer.from('name,target_url\nA,https://x.test'), 'a.csv');
    assert.equal(noToken.status, 403);
    const badToken = await admin.post('/admin/import').field('_csrf', 'salah').attach('file', Buffer.from('name,target_url\nA,https://x.test'), 'a.csv');
    assert.equal(badToken.status, 403);
    const validToken = await csrfFor(admin, '/admin/import'); // fetched first: never interleave requests while building another
    const crossSite = await admin.post('/admin/import').set('Sec-Fetch-Site', 'cross-site').field('_csrf', validToken).attach('file', Buffer.from('name,target_url\nA,https://x.test'), 'a.csv');
    assert.equal(crossSite.status, 403);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);

    await makeUser(t.ctx, { username: 'pembaca', role: 'viewer' });
    const viewer = await loginAgent(t, { identifier: 'pembaca' });
    assert.equal((await uploadCsv(viewer, 'name,target_url\nA,https://x.test', { page: '/admin' })).status, 403);

    const anonymous = await t.request().post('/admin/import').attach('file', Buffer.from('name,target_url\nA,https://x.test'), 'a.csv');
    assert.equal(anonymous.status, 302, 'an expired/missing session sends the browser to the login page');
    assert.equal(anonymous.headers.location, '/login');
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
  });

  it('neutralises spreadsheet formulas on the way in and out (CSV injection)', async () => {
    const res = await uploadCsv(admin, "name,description,target_url\n=HYPERLINK(\"http://evil\"),+cmd|calc,https://x.test/1\n'=SUM(1),ok,https://x.test/2");
    assert.equal(res.status, 302);
    const rows = await t.db.rows('SELECT name, description FROM barcodes ORDER BY id');
    assert.equal(rows[0].name, '=HYPERLINK("http://evil")');
    assert.equal(rows[1].name, '=SUM(1)', 'the guard apostrophe added by a previous export is stripped again');

    const exported = await admin.get('/admin/barcodes/export.csv');
    const lines = bodyOf(exported).split('\r\n');
    assert.ok(lines[1].includes("\"'=HYPERLINK("), 'formula cell is prefixed with an apostrophe');
    assert.ok(lines[1].includes("'+cmd|calc"));
    const parsed = parseCsv(exported.text);
    assert.equal(parsed.rows[0].data.name, "'=HYPERLINK(\"http://evil\")");
  });
});

describe('CSV export', () => {
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

  it('exports all columns with BOM, local times and the QR address', async () => {
    await insertBarcodes(t.ctx, [
      { name: 'Menu, Meja "A"', description: 'Baris 1\nBaris 2', targetUrl: 'https://example.com/menu?x=1&y=2', expiredLocal: '2099-05-06 07:08:09' },
      { name: 'Nonaktif', status: 'inactive' },
    ]);
    await t.db.query("UPDATE barcodes SET scan_count = 42, created_at = '2026-09-23 03:00:00+00' WHERE code = 'BR-000001'");
    const res = await admin.get('/admin/barcodes/export.csv');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/csv; charset=utf-8/);
    assert.match(res.headers['content-disposition'], /^attachment; filename="barcodes-\d{8}-\d{4}\.csv"$/);
    assert.equal(res.text.charCodeAt(0), 0xfeff, 'UTF-8 BOM so Excel opens it correctly');

    const { headers, rows } = parseCsv(res.text);
    assert.deepEqual(headers, ['code', 'name', 'description', 'target_type', 'target_url', 'qr_url', 'status', 'state', 'expired_at', 'scan_count', 'last_scanned_at', 'created_at', 'updated_at']);
    assert.equal(rows.length, 2);
    const a = rows[0].data;
    assert.equal(a.code, 'BR-000001');
    assert.equal(a.name, 'Menu, Meja "A"');
    assert.equal(a.description, 'Baris 1\nBaris 2');
    assert.equal(a.target_url, 'https://example.com/menu?x=1&y=2');
    assert.equal(a.qr_url, 'https://barcode.test/b/BR-000001');
    assert.equal(a.expired_at, '2099-05-06 07:08:09');
    assert.equal(a.scan_count, '42');
    assert.equal(a.created_at, '2026-09-23 10:00:00', 'Asia/Jakarta local time');
    assert.deepEqual([rows[1].data.status, rows[1].data.state], ['inactive', 'inactive']);
  });

  it('exports with a semicolon delimiter for Excel with Indonesian regional settings', async () => {
    await insertBarcodes(t.ctx, [{ name: 'Satu; dua' }]);
    const res = await admin.get('/admin/barcodes/export.csv?sep=semicolon');
    const parsed = parseCsv(res.text);
    assert.equal(parsed.delimiter, ';');
    assert.equal(parsed.rows[0].data.name, 'Satu; dua');
    assert.match(res.text.split('\r\n')[0], /code;name;description/);
  });

  it('honours the list filters (search, status, dates)', async () => {
    await insertBarcodes(t.ctx, [{ name: 'Kopi A' }, { name: 'Kopi B', status: 'inactive' }, { name: 'Teh C' }]);
    const names = async (qs) => parseCsv((await admin.get(`/admin/barcodes/export.csv?${qs}`)).text).rows.map((r) => r.data.name);
    assert.deepEqual(await names('q=kopi'), ['Kopi A', 'Kopi B']);
    assert.deepEqual(await names('q=kopi&status=inactive'), ['Kopi B']);
    assert.deepEqual(await names('status=active'), ['Kopi A', 'Teh C']);
    assert.deepEqual(await names('from=2001-01-01&to=2001-01-02'), []);
    assert.deepEqual(await names('q=zzz'), []);
  });

  it('streams large exports in batches without dropping or duplicating rows (4.500 rows > batch size)', async () => {
    await insertBarcodes(t.ctx, Array.from({ length: 4500 }, (_, i) => ({ name: `Item ${i + 1}`, targetUrl: `https://example.com/i/${i + 1}` })));
    const res = await admin.get('/admin/barcodes/export.csv');
    const { rows } = parseCsv(res.text);
    assert.equal(rows.length, 4500);
    assert.equal(new Set(rows.map((r) => r.data.code)).size, 4500);
    assert.equal(rows[0].data.code, 'BR-000001');
    assert.equal(rows[4499].data.code, 'BR-004500');
    assert.deepEqual(rows.map((r) => r.data.code), [...rows.map((r) => r.data.code)].sort(), 'ordered by id');
  });

  it('an empty database exports just the header row', async () => {
    const res = await admin.get('/admin/barcodes/export.csv');
    assert.equal(res.status, 200);
    assert.equal(parseCsv(res.text).rows.length, 0);
  });
});
