import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { UA, insertBarcodes, loginAgent, makeUser, postForm, scan, startApp } from '../helpers/app.js';

describe('pages render', () => {
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
    await insertBarcodes(t.ctx, [{ name: 'Menu Meja' }, { name: 'Nonaktif', status: 'inactive' }]);
    await scan(t, 'BR-000001', { ua: UA.android });
  });

  it('public pages: landing (with Login Admin), login, 404, robots, health', async () => {
    const landing = await t.request().get('/');
    assert.equal(landing.status, 200);
    assert.match(landing.text, /Dynamic Barcode <em>Management<\/em>/);
    assert.match(landing.text, /Kelola barcode dinamis dan ubah tujuan barcode kapan saja tanpa perlu mencetak ulang\./);
    assert.match(landing.text, /<a class="btn btn--primary[^"]*" href="\/login">Login Admin/);
    assert.match(landing.text, /<svg[^>]*viewBox/, 'the illustration QR is rendered');
    assert.match(landing.text, /index, follow/);
    assert.equal(landing.headers['set-cookie'], undefined, 'anonymous landing visits must not create sessions');
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM user_sessions')).n, 1, 'only the admin session exists');

    const missing = await t.request().get('/halaman/tidak/ada');
    assert.equal(missing.status, 404);
    assert.match(missing.text, /Halaman tidak ditemukan/);
    assert.ok(!missing.text.includes('Cannot GET'), 'no framework default error page');

    assert.equal((await t.request().get('/healthz')).status, 200);
    assert.equal((await t.request().get('/favicon.ico')).status, 200);
  });

  it('every admin page renders with the basics of an accessible document', async () => {
    const paths = ['/admin', '/admin/barcodes', '/admin/barcodes/new', '/admin/barcodes/BR-000001', '/admin/barcodes/BR-000001/edit', '/admin/import', '/admin/analytics', '/admin/history', '/admin/settings'];
    for (const path of paths) {
      const res = await admin.get(path);
      assert.equal(res.status, 200, path);
      assert.match(res.text, /<html lang="id">/, path);
      assert.match(res.text, /<title>[^<]+ \| Dynamic Barcode<\/title>/, path);
      assert.match(res.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/, path);
      assert.match(res.text, /class="skip-link"/, path);
      assert.match(res.text, /<main class="content" id="main"/, path);
      assert.equal((res.text.match(/<h1\b/g) ?? []).length, 1, `${path}: exactly one h1`);
      assert.match(res.text, /aria-current="page"/, `${path}: current nav item is marked`);
      // every form field that is not hidden has a label or aria-label
      const inputs = [...res.text.matchAll(/<(input|select|textarea)\b([^>]*)>/g)].filter((m) => !/type="hidden"/.test(m[2]));
      for (const [, tag, attrs] of inputs) {
        const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
        const labelled = /aria-label=/.test(attrs) || (id && new RegExp(`for="${id}"`).test(res.text)) || /type="radio"|type="checkbox"/.test(attrs);
        assert.ok(labelled, `${path}: <${tag} ${attrs.trim().slice(0, 60)}> has no accessible name`);
      }
    }
  });

  it('shows the fields, actions and labels the brief asks for', async () => {
    const form = (await admin.get('/admin/barcodes/new')).text;
    for (const needle of ['Nama barcode', 'Keterangan', 'Tipe tujuan', 'URL tujuan', 'Aktif', 'Nonaktif', 'Tanggal kedaluwarsa', 'Buat barcode']) assert.ok(form.includes(needle), `create form: ${needle}`);

    const list = (await admin.get('/admin/barcodes')).text;
    for (const needle of ['Kode', 'Nama', 'Tujuan', 'Status', 'Total Scan', 'Dibuat', 'Export CSV', 'Import', 'Cari nama, kode, atau URL tujuan', 'Semua status', 'Pilih semua barcode di halaman ini', 'Cetak QR', 'Download QR (PNG)', 'Download QR (SVG)', 'Nonaktifkan', 'Hapus', 'Aktifkan', 'Lihat detail']) assert.ok(list.includes(needle), `list: ${needle}`);

    const nav = (await admin.get('/admin')).text;
    for (const needle of ['Dashboard', 'Semua Barcode', 'Buat Barcode', 'Import', 'Scan Analytics', 'Riwayat', 'Pengaturan']) assert.ok(nav.includes(needle), `sidebar: ${needle}`);

    const dash = nav;
    for (const needle of ['Total barcode', 'Barcode aktif', 'Barcode nonaktif', 'Jumlah scan', 'Scan hari ini', 'Scan 7 hari terakhir', 'Paling sering dipindai', 'Scan per hari']) assert.ok(dash.includes(needle), `dashboard: ${needle}`);
    assert.match(dash, /data-chart="line"/);
    assert.match(dash, /Lihat tabel/, 'every chart has a table view');
  });

  it('destructive controls open a confirmation dialog first (data-confirm + dialog present)', async () => {
    const list = (await admin.get('/admin/barcodes')).text;
    assert.match(list, /<dialog class="dialog" id="confirm-dialog"/);
    assert.match(list, /data-confirm data-confirm-variant="danger"[^>]*data-confirm-title="Hapus BR-\d+\?"/);
    assert.match(list, /data-confirm data-confirm-title="Nonaktifkan BR-000001\?"/);
    const bulk = list.match(/data-bulk-action="delete"[^>]*/)[0];
    assert.match(bulk, /data-confirm/);
    const detail = (await admin.get('/admin/barcodes/BR-000001')).text;
    assert.match(detail, /data-confirm-title="Hapus BR-000001\?"/);
    assert.match(detail, /data-confirm-title="Nonaktifkan BR-000001\?"/);
    assert.match(list, /id="toasts"[^>]*data-flash=/, 'toast container present');
  });

  it('flash messages become toast payloads exactly once', async () => {
    const created = await postForm(admin, '/admin/barcodes', { name: 'Baru', target_type: 'url', target_value: 'https://example.com/z', status: 'active' }, { tokenPage: '/admin/barcodes/new' });
    const first = await admin.get(created.headers.location);
    assert.match(first.text, /data-flash="\[\{&quot;type&quot;:&quot;success&quot;,&quot;message&quot;:&quot;Barcode berhasil dibuat/);
    const second = await admin.get(created.headers.location);
    assert.match(second.text, /data-flash="\[\]"/, 'the message is consumed');

    await postForm(admin, '/admin/barcodes/BR-000003', { name: 'Baru', target_type: 'url', target_value: 'https://example.com/y', status: 'active' }, { tokenPage: '/admin/barcodes/BR-000003/edit' });
    assert.match((await admin.get('/admin/barcodes/BR-000003')).text, /Barcode berhasil diperbarui/);
    await postForm(admin, '/admin/barcodes/BR-000003/delete', {}, { tokenPage: '/admin' });
    assert.match((await admin.get('/admin/barcodes')).text, /Barcode BR-000003 berhasil dihapus/);
  });

  it('barcode detail shows everything the brief lists', async () => {
    await t.db.query("UPDATE barcodes SET expired_at = '2099-01-01 00:00:00+07' WHERE code = 'BR-000001'");
    const page = (await admin.get('/admin/barcodes/BR-000001')).text;
    for (const needle of ['BR-000001', 'Menu Meja', 'URL tujuan saat ini', 'Status', 'Dibuat', 'Diperbarui', 'Kedaluwarsa', '01-01-2099 00:00', 'Total scan', 'Scan hari ini', '7 hari terakhir', 'Edit Barcode', 'Download PNG', 'Download SVG', 'Print', 'Nonaktifkan', 'Riwayat perubahan tujuan', 'Scan terbaru', 'Statistik scan']) assert.ok(page.includes(needle), `detail: ${needle}`);
    assert.match(page, /data-chart="line"/);
    assert.match(page, /Perangkat/);
    assert.match(page, /Browser/);
    assert.match(page, /Sistem operasi/);
  });

  it('empty states are friendly on a fresh installation', async () => {
    await t.db.query('DELETE FROM barcodes');
    const dash = (await admin.get('/admin')).text;
    assert.match(dash, /Belum ada barcode/);
    const list = (await admin.get('/admin/barcodes')).text;
    assert.match(list, /Belum ada barcode/);
    const history = (await admin.get('/admin/history')).text;
    assert.match(history, /Belum ada perubahan tujuan/);
    const analytics = (await admin.get('/admin/analytics')).text;
    assert.match(analytics, /Belum ada scan pada rentang waktu ini/);
    for (const path of ['/admin', '/admin/barcodes', '/admin/history', '/admin/analytics', '/admin/import']) assert.equal((await admin.get(path)).status, 200, path);
  });

  it('settings page shows profile, password change and read-only system information', async () => {
    const page = (await admin.get('/admin/settings')).text;
    for (const needle of ['Profil admin', 'Ganti password', 'Password saat ini', 'Password baru', 'Sistem', 'https://barcode.test', 'Asia/Jakarta', 'PostgreSQL']) assert.ok(page.includes(needle), needle);
    assert.ok(!/SESSION_SECRET|DATABASE_URL|postgres:\/\//.test(page), 'no credentials on the settings page');
  });

  it('error pages inside the admin keep the admin layout, outside they use the public one', async () => {
    const inside = await admin.get('/admin/barcodes/BR-999999');
    assert.equal(inside.status, 404);
    assert.match(inside.text, /Kembali ke dashboard/);
    assert.match(inside.text, /class="sidebar"/);
    const outside = await t.request().get('/tidak-ada');
    assert.match(outside.text, /Kembali ke beranda/);
    assert.ok(!outside.text.includes('class="sidebar"'));
  });
});

describe('change history', () => {
  let t;
  let admin;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await makeUser(t.ctx, { username: 'admin', name: 'Admin Satu' });
    await makeUser(t.ctx, { username: 'rina', name: 'Rina' });
    admin = await loginAgent(t);
    await insertBarcodes(t.ctx, [{ name: 'Alfa', targetUrl: 'https://contoh.com/a' }, { name: 'Beta', targetUrl: 'https://contoh.com/b' }]);
  });

  // keeps the original names ("Alfa" = BR-000001, "Beta" = BR-000002) so name searches stay meaningful
  const edit = (agent, code, url) => postForm(agent, `/admin/barcodes/${code}`, { name: code === 'BR-000001' ? 'Alfa' : 'Beta', target_type: 'url', target_value: url, status: 'active' }, { tokenPage: `/admin/barcodes/${code}/edit` });

  it('records who changed what and when, and lists it newest-first in the global history', async () => {
    const rina = await loginAgent(t, { identifier: 'rina' });
    await makeUser(t.ctx, { username: 'rina2', role: 'admin' }).catch(() => {});
    await edit(admin, 'BR-000001', 'https://contoh.com/a2');
    await edit(rina, 'BR-000001', 'https://contoh.com/a3');
    await edit(admin, 'BR-000002', 'https://contoh.com/b2');

    const rows = await t.db.rows('SELECT h.id, b.code, h.old_url, h.new_url, u.username, h.changed_at FROM barcode_history h JOIN barcodes b ON b.id = h.barcode_id JOIN users u ON u.id = h.changed_by ORDER BY h.id');
    assert.deepEqual(rows.map((r) => [r.code, r.old_url, r.new_url, r.username]), [
      ['BR-000001', 'https://contoh.com/a', 'https://contoh.com/a2', 'admin'],
      ['BR-000001', 'https://contoh.com/a2', 'https://contoh.com/a3', 'rina'],
      ['BR-000002', 'https://contoh.com/b', 'https://contoh.com/b2', 'admin'],
    ]);

    const page = (await admin.get('/admin/history')).text;
    assert.equal(page.match(/<tr>\s*<td class="nowrap">\d{2}-\d{2}-\d{4} \d{2}:\d{2}<\/td>/g).length, 3, 'time is shown as dd-mm-yyyy HH:mm');
    assert.ok(page.indexOf('contoh.com/b2') < page.indexOf('contoh.com/a3'), 'newest first');
    assert.match(page, /rina/);
    assert.match(page, /URL lama/);
    assert.match(page, /URL baru/);
  });

  it('searches and filters the history, and paginates it', async () => {
    for (let i = 1; i <= 30; i += 1) await edit(admin, i % 2 ? 'BR-000001' : 'BR-000002', `https://contoh.com/v${i}`);
    const total = (page) => Number(/dari (\d+)/.exec(page)?.[1]);
    assert.equal(total((await admin.get('/admin/history')).text), 30);
    assert.equal(total((await admin.get('/admin/history?q=BR-000002')).text), 15);
    assert.equal(total((await admin.get('/admin/history?q=contoh.com%2Fv17')).text), 2, 'v17 is the NEW url of one row and the OLD url of the next edit');
    assert.equal(total((await admin.get('/admin/history?q=Beta')).text), 15);
    const paged = await admin.get('/admin/history?per_page=10&page=3');
    assert.match(paged.text, /21-30 dari 30/);
    const none = await admin.get('/admin/history?q=tidak-ada&from=2001-01-01&to=2001-01-02');
    assert.match(none.text, /Tidak ada riwayat yang cocok/);
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
    assert.equal(total((await admin.get(`/admin/history?from=${today}&to=${today}`)).text), 30);
    assert.equal((await admin.get('/admin/history?from=xx&page=-1&per_page=oops')).status, 200);
  });

  it('is created only by real URL changes (not by creation, imports, renames or status changes)', async () => {
    await postForm(admin, '/admin/barcodes', { name: 'Baru', target_type: 'url', target_value: 'https://contoh.com/n', status: 'active' }, { tokenPage: '/admin/barcodes/new' });
    await postForm(admin, '/admin/barcodes/BR-000001/status', { status: 'inactive' }, { tokenPage: '/admin' });
    await postForm(admin, '/admin/barcodes/BR-000001', { name: 'Ganti nama saja', target_type: 'url', target_value: 'https://contoh.com/a', status: 'inactive' }, { tokenPage: '/admin/barcodes/BR-000001/edit' });
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_history')).n, 0);
    await edit(admin, 'BR-000001', 'https://contoh.com/a');
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_history')).n, 0, 'saving the same URL again is not a change');
  });

  it('a barcode page shows only its own history; deleting the admin keeps the record', async () => {
    await edit(admin, 'BR-000001', 'https://contoh.com/a2');
    await edit(admin, 'BR-000002', 'https://contoh.com/b2');
    const own = (await admin.get('/admin/barcodes/BR-000001')).text;
    assert.match(own, /contoh\.com\/a2/);
    assert.ok(!own.includes('contoh.com/b2'));
    await t.db.query("DELETE FROM users WHERE username = 'rina'");
    await t.db.query("UPDATE barcode_history SET changed_by = NULL");
    const page = (await admin.get('/admin/history')).text;
    assert.match(page, /contoh\.com\/a2/, 'orphaned history rows still render');
  });
});
