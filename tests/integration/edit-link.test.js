import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import jsQR from 'jsqr';
import pino from 'pino';
import { PNG } from 'pngjs';
import supertest from 'supertest';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import * as repo from '../../src/modules/barcodes/barcodes.repo.js';
import { editTokenOf, getBuffer, insertBarcodes, loginAgent, makeUser, postForm, scan, startApp, uploadCsv } from '../helpers/app.js';

const decode = (buffer) => {
  const png = PNG.sync.read(buffer);
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
};

/**
 * Somebody without an account: no cookies, only the link. The link opens the INFO page; the form is a second
 * page (`${link}/edit`), and that is also where it is submitted.
 */
const holder = (t) => ({
  open: (link) => t.request().get(link),
  form: (link) => t.request().get(`${link}/edit`),
  save: (link, fields) => t.request().post(`${link}/edit`).type('form').send(fields),
});

const URL_FIELDS = (target_value, extra = {}) => ({ target_type: 'url', target_value, ...extra });

describe('barcodes that are filled in later (admin side)', () => {
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
    postForm(admin, '/admin/barcodes', { name: 'Stiker Inventaris Lab', description: 'Isinya menyusul', target_type: 'url', target_value: '', status: 'active', ...fields }, { tokenPage: '/admin/barcodes/new' });

  it('creates a barcode with no destination, and gives it its own edit link', async () => {
    const res = await create();
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/barcodes/BR-000001#link-edit');

    const row = await t.db.one("SELECT target_url, target_type, edit_token, status FROM barcodes WHERE code = 'BR-000001'");
    assert.equal(row.target_url, null);
    assert.equal(row.target_type, 'url');
    assert.equal(row.status, 'active');
    assert.match(row.edit_token, /^[A-Za-z0-9_-]{43}$/, '256 random bits, URL-safe');

    const detail = await admin.get('/admin/barcodes/BR-000001');
    assert.equal(detail.status, 200);
    assert.match(detail.text, /Barcode dibuat, tujuannya belum diisi/, 'toast after the redirect');
    assert.match(detail.text, /Belum diisi/);
    assert.match(detail.text, /Link edit tanpa login/);
    assert.ok(detail.text.includes(`https://barcode.test/e/${row.edit_token}`), 'the admin can copy the link');
    assert.match(detail.text, /Buka halaman edit/);
  });

  it('a barcode created WITH a destination also gets a link, and no toast about waiting', async () => {
    const res = await create({ target_value: 'https://contoh.com/langsung' });
    assert.equal(res.headers.location, '/admin/barcodes/BR-000001');
    assert.match(await editTokenOf(t.ctx, 'BR-000001'), /^[A-Za-z0-9_-]{43}$/);
    assert.match((await admin.get(res.headers.location)).text, /Barcode berhasil dibuat/);
  });

  it('every barcode has a different link, including barcodes created in bulk', async () => {
    await create({ name: 'A' });
    await create({ name: 'B' });
    await insertBarcodes(t.ctx, Array.from({ length: 50 }, (_, i) => ({ name: `Massal ${i}`, targetUrl: i % 2 ? null : 'https://contoh.com/x' })));
    const tokens = (await t.db.rows('SELECT edit_token FROM barcodes')).map((r) => r.edit_token);
    assert.equal(tokens.length, 52);
    assert.equal(new Set(tokens).size, 52);
    assert.ok(tokens.every((tk) => /^[A-Za-z0-9_-]{43}$/.test(tk)));
  });

  it('a half-filled destination is still refused, and nothing is created', async () => {
    const res = await create({ target_type: 'whatsapp', target_value: '', target_extra: 'Halo!' });
    assert.equal(res.status, 422);
    assert.match(res.text, /Nomor WhatsApp tidak valid/);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
  });

  it('a filled destination is validated exactly as before', async () => {
    for (const evil of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', 'https://barcode.test/b/BR-000001']) {
      assert.equal((await create({ target_value: evil })).status, 422, evil);
    }
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
  });

  it('scanning it shows "Barcode Belum Diisi": a page rather than an error, nothing counted, nothing leaked', async () => {
    await create();
    const res = await scan(t, 'BR-000001');
    assert.equal(res.status, 200);
    assert.match(res.text, /Barcode Belum Diisi/);
    assert.equal(res.headers.location, undefined, 'there is nowhere to redirect to');
    assert.match(res.headers['cache-control'], /no-store/);
    assert.match(res.headers['x-robots-tag'], /noindex/);
    assert.ok(!res.text.includes('/e/'), 'the edit link is never shown to people who scan');
    assert.equal((await t.db.one('SELECT scan_count FROM barcodes')).scan_count, 0, 'a visit that leads nowhere is not a scan');
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_scans')).n, 0);
  });

  it('inactive and expired still win over "not filled in yet"', async () => {
    await insertBarcodes(t.ctx, [{ targetUrl: null, status: 'inactive' }, { targetUrl: null, expiredLocal: '2001-01-01 00:00:00' }]);
    const inactive = await scan(t, 'BR-000001');
    assert.equal(inactive.status, 403);
    assert.match(inactive.text, /Barcode Tidak Aktif/);
    const expired = await scan(t, 'BR-000002');
    assert.equal(expired.status, 410);
    assert.match(expired.text, /Barcode Sudah Tidak Berlaku/);
  });

  it('an admin can fill it in through the normal edit form; the history starts from nothing', async () => {
    await create();
    const res = await postForm(admin, '/admin/barcodes/BR-000001', { name: 'Stiker Inventaris Lab', target_type: 'url', target_value: 'https://contoh.com/lab', status: 'active' }, { tokenPage: '/admin/barcodes/BR-000001/edit' });
    assert.equal(res.status, 302);
    const ok = await scan(t, 'BR-000001');
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, 'https://contoh.com/lab');

    const history = await t.db.rows('SELECT old_url, new_url, changed_via, changed_by, changed_ip FROM barcode_history');
    assert.equal(history.length, 1);
    assert.equal(history[0].old_url, null);
    assert.equal(history[0].new_url, 'https://contoh.com/lab');
    assert.equal(history[0].changed_via, 'admin');
    assert.ok(history[0].changed_by);
    assert.equal(history[0].changed_ip, null);
  });

  it('a destination that is filled in cannot be blanked again; one that never had one may stay blank', async () => {
    await create({ target_value: 'https://contoh.com/isi' });
    const blank = await postForm(admin, '/admin/barcodes/BR-000001', { name: 'x', target_type: 'url', target_value: '', status: 'active' }, { tokenPage: '/admin/barcodes/BR-000001/edit' });
    assert.equal(blank.status, 422);
    assert.match(blank.text, /URL tujuan wajib diisi/);
    assert.equal((await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'")).target_url, 'https://contoh.com/isi');

    await create({ name: 'Kosong' });
    const rename = await postForm(admin, '/admin/barcodes/BR-000002', { name: 'Kosong (diganti)', target_type: 'url', target_value: '', status: 'active' }, { tokenPage: '/admin/barcodes/BR-000002/edit' });
    assert.equal(rename.status, 302);
    const row = await t.db.one("SELECT name, target_url FROM barcodes WHERE code = 'BR-000002'");
    assert.deepEqual({ ...row }, { name: 'Kosong (diganti)', target_url: null });
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_history')).n, 0, 'nothing about the destination changed');
  });

  it('the edit form explains that the destination is optional only while it is', async () => {
    await create();
    await create({ name: 'Terisi', target_value: 'https://contoh.com/terisi' });
    assert.match((await admin.get('/admin/barcodes/new')).text, /Belum tahu tujuannya/);
    assert.match((await admin.get('/admin/barcodes/BR-000001/edit')).text, /Belum tahu tujuannya/);
    assert.doesNotMatch((await admin.get('/admin/barcodes/BR-000002/edit')).text, /Belum tahu tujuannya/);
  });

  it('the list, its filter, the dashboard counts and the CSV export all understand the new state', async () => {
    await insertBarcodes(t.ctx, [
      { name: 'Alfa Terisi' },
      { name: 'Bravo Kosong', targetUrl: null },
      { name: 'Charlie Nonaktif', targetUrl: null, status: 'inactive' },
      { name: 'Delta Kedaluwarsa', targetUrl: null, expiredLocal: '2001-01-01 00:00:00' },
    ]);
    const counts = await repo.counts(t.db);
    assert.deepEqual(
      { total: counts.total, active: counts.active, pending: counts.pending, inactive: counts.inactive, expired: counts.expired },
      { total: 4, active: 1, pending: 1, inactive: 1, expired: 1 },
      'the four states add up to the total: nothing is counted twice',
    );

    const pending = await admin.get('/admin/barcodes?status=pending');
    assert.match(pending.text, /Bravo Kosong/);
    assert.doesNotMatch(pending.text, /Alfa Terisi|Charlie Nonaktif|Delta Kedaluwarsa/);
    assert.match(pending.text, /target-link--empty/);
    assert.match(pending.text, /badge--blue/);

    const active = await admin.get('/admin/barcodes?status=active');
    assert.match(active.text, /Alfa Terisi/);
    assert.doesNotMatch(active.text, /Bravo Kosong/, 'an unfilled barcode is not "active"');
    assert.match((await admin.get('/admin/barcodes?status=inactive')).text, /Charlie Nonaktif/);
    assert.match((await admin.get('/admin/barcodes?status=expired')).text, /Delta Kedaluwarsa/);

    const dashboard = await admin.get('/admin');
    assert.match(dashboard.text, /Belum diisi/);
    assert.match(dashboard.text, /href="\/admin\/barcodes\?status=pending"/);

    const csv = await admin.get('/admin/barcodes/export.csv');
    assert.match(csv.text, /BR-000002,Bravo Kosong,,url,,https:\/\/barcode\.test\/b\/BR-000002,active,pending,/, 'empty destination cell, state "pending"');
  });

  it('CSV import still needs a destination in every row, and its barcodes get edit links too', async () => {
    const res = await uploadCsv(admin, 'name,target_url\nTanpa Tujuan,\nDengan Tujuan,https://contoh.com/x\n');
    assert.equal(res.status, 302);
    const rows = await t.db.rows('SELECT name, target_url, edit_token FROM barcodes');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Dengan Tujuan');
    assert.match(rows[0].edit_token, /^[A-Za-z0-9_-]{43}$/);
    const batch = await t.db.one('SELECT errors FROM import_batches');
    assert.match(batch.errors[0].reason, /URL tujuan wajib diisi/);
  });

  it('the admin can replace the link (the old one dies at once), revoke it, and issue a new one', async () => {
    await create();
    const first = await editTokenOf(t.ctx, 'BR-000001');

    const replaced = await postForm(admin, '/admin/barcodes/BR-000001/edit-link', {}, { tokenPage: '/admin' });
    assert.equal(replaced.status, 302);
    assert.equal(replaced.headers.location, '/admin/barcodes/BR-000001#link-edit');
    const second = await editTokenOf(t.ctx, 'BR-000001');
    assert.notEqual(second, first);
    assert.equal((await holder(t).open(`/e/${first}`)).status, 404, 'the replaced link is dead');
    assert.equal((await holder(t).save(`/e/${first}`, URL_FIELDS('https://contoh.com/lama'))).status, 404, 'and cannot save either');
    assert.equal((await holder(t).open(`/e/${second}`)).status, 200);

    const revoked = await postForm(admin, '/admin/barcodes/BR-000001/edit-link/revoke', {}, { tokenPage: '/admin' });
    assert.equal(revoked.status, 302);
    assert.equal(await editTokenOf(t.ctx, 'BR-000001'), null);
    assert.equal((await holder(t).open(`/e/${second}`)).status, 404);
    assert.equal((await holder(t).save(`/e/${second}`, URL_FIELDS('https://contoh.com/x'))).status, 404);
    assert.match((await admin.get('/admin/barcodes/BR-000001')).text, /Barcode ini belum punya link edit/);
    assert.equal((await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'")).target_url, null, 'nothing was saved through the dead links');

    await postForm(admin, '/admin/barcodes/BR-000001/edit-link', {}, { tokenPage: '/admin' });
    const third = await editTokenOf(t.ctx, 'BR-000001');
    assert.match(third, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await holder(t).open(`/e/${third}`)).status, 200);
  });

  it('rotating or revoking the link is not an edit of the barcode: updated_at stays', async () => {
    await create();
    const before = (await t.db.one("SELECT updated_at FROM barcodes WHERE code = 'BR-000001'")).updated_at;
    await new Promise((r) => setTimeout(r, 15));
    await postForm(admin, '/admin/barcodes/BR-000001/edit-link', {}, { tokenPage: '/admin' });
    await postForm(admin, '/admin/barcodes/BR-000001/edit-link/revoke', {}, { tokenPage: '/admin' });
    assert.equal((await t.db.one("SELECT updated_at FROM barcodes WHERE code = 'BR-000001'")).updated_at.getTime(), before.getTime());
  });

  it('deleting the barcode kills its link', async () => {
    await create();
    const link = `/e/${await editTokenOf(t.ctx, 'BR-000001')}`;
    await postForm(admin, '/admin/barcodes/BR-000001/delete', {}, { tokenPage: '/admin' });
    assert.equal((await holder(t).open(link)).status, 404);
  });

  it('a read-only viewer never sees the link, and cannot issue or revoke one', async () => {
    await create();
    const token = await editTokenOf(t.ctx, 'BR-000001');
    await makeUser(t.ctx, { username: 'viewer', role: 'viewer' });
    const viewer = await loginAgent(t, { identifier: 'viewer' });

    const detail = await viewer.get('/admin/barcodes/BR-000001');
    assert.equal(detail.status, 200);
    assert.ok(!detail.text.includes(token), 'the secret is not in the page');
    assert.doesNotMatch(detail.text, /Link edit tanpa login/);
    assert.match(detail.text, /Belum diisi/, 'they still see the state');

    assert.equal((await postForm(viewer, '/admin/barcodes/BR-000001/edit-link', {}, { tokenPage: '/admin' })).status, 403);
    assert.equal((await postForm(viewer, '/admin/barcodes/BR-000001/edit-link/revoke', {}, { tokenPage: '/admin' })).status, 403);
    assert.equal(await editTokenOf(t.ctx, 'BR-000001'), token, 'unchanged');

    // ...and the token is not in any list or export they can open either
    assert.ok(!(await viewer.get('/admin/barcodes')).text.includes(token));
    assert.ok(!(await viewer.get('/admin/barcodes/export.csv')).text.includes(token));
  });

  it('the token is not in the list, the export, the edit form or the print page, even for admins', async () => {
    await create();
    const token = await editTokenOf(t.ctx, 'BR-000001');
    for (const page of ['/admin', '/admin/barcodes', '/admin/barcodes/export.csv', '/admin/barcodes/BR-000001/edit', '/admin/barcodes/BR-000001/print', '/admin/history', '/admin/analytics']) {
      assert.ok(!(await admin.get(page)).text.includes(token), `${page} must not print the secret`);
    }
  });

  it('nobody can issue or revoke a link without being signed in', async () => {
    await create();
    const token = await editTokenOf(t.ctx, 'BR-000001');
    const anon = t.request();
    assert.equal((await anon.post('/admin/barcodes/BR-000001/edit-link').type('form').send({})).status, 403, 'no CSRF token');
    assert.equal((await anon.post('/admin/barcodes/BR-000001/edit-link/revoke').type('form').send({})).status, 403);
    assert.equal(await editTokenOf(t.ctx, 'BR-000001'), token);
  });
});

describe('public edit link: an info page (/e/{token}) and a form page (/e/{token}/edit)', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
  });

  const pendingBarcode = async (fields = {}) => {
    await insertBarcodes(t.ctx, [{ name: 'Menu Meja 5', description: 'RAHASIA-CATATAN-ADMIN', targetUrl: null, ...fields }]);
    return `/e/${await editTokenOf(t.ctx, 'BR-000001')}`;
  };

  /** Everything both pages must have in common: nothing to steal, nothing to ride, nothing cached or indexed. */
  const assertPrivate = (res) => {
    assert.equal(res.status, 200);
    assert.equal(res.headers['set-cookie'], undefined, 'no cookie: there is nothing to steal or ride');
    assert.match(res.headers['cache-control'], /no-store/);
    assert.match(res.headers['x-robots-tag'], /noindex/);
    assert.equal(res.headers['referrer-policy'], 'no-referrer', 'the secret in the URL never leaks through a Referer header');
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/, 'cannot be framed');
    assert.doesNotMatch(res.text, /RAHASIA-CATATAN-ADMIN/, 'the private description is not shown');
    assert.doesNotMatch(res.text, /Statistik|Scan terakhir|_csrf|csrf-token|\/admin/, 'no admin features, no CSRF token');
  };

  it('the link opens an INFO page without any login: what the barcode is, where it points, and no form', async () => {
    const link = await pendingBarcode();
    const res = await holder(t).open(link);
    assertPrivate(res);

    assert.match(res.text, /Info barcode/);
    assert.match(res.text, /BR-000001/);
    assert.match(res.text, /Menu Meja 5/);
    assert.match(res.text, /Tujuan saat ini/);
    assert.match(res.text, /Belum diisi/);
    assert.match(res.text, /edit-card__qr/, 'shows the QR so the person knows which sticker this is');
    assert.ok(res.text.includes(`href="${link}/edit"`), 'a button leads to the form page');
    assert.match(res.text, /Isi tujuan/);
    assert.doesNotMatch(res.text, /<form|name="target_value"|type-grid|Simpan tujuan/, 'the form is NOT on this page');
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM user_sessions')).n, 0, 'no session row either');
  });

  it('the FORM is a page of its own: just the destination fields and a way back, no QR and no status', async () => {
    const link = await pendingBarcode();
    const res = await holder(t).form(link);
    assertPrivate(res);

    assert.match(res.text, /Isi tujuan barcode/);
    assert.match(res.text, /BR-000001/, 'still says which barcode this is');
    assert.match(res.text, /Menu Meja 5/);
    assert.ok(res.text.includes(`action="${link}/edit"`), 'it submits to its own address');
    assert.match(res.text, /name="target_type"/);
    assert.match(res.text, /name="target_value"/);
    assert.match(res.text, /Simpan tujuan/);
    assert.ok(res.text.includes(`href="${link}"`), 'a way back to the info page (Batal and the link at the top)');
    assert.doesNotMatch(res.text, /edit-card__qr|edit-now|Tujuan saat ini|badge/, 'the info lives on the info page');
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM user_sessions')).n, 0);
  });

  it('both pages tell a barcode that has a destination from one that has none', async () => {
    const empty = await pendingBarcode();
    assert.match((await holder(t).open(empty)).text, /Isi tujuan/);
    assert.match((await holder(t).form(empty)).text, /<h1[^>]*>Isi tujuan barcode<\/h1>/);
    await t.reset();

    const link = await pendingBarcode({ targetUrl: 'https://contoh.com/tujuan-lama' });
    const info = await holder(t).open(link);
    assert.match(info.text, /Ubah tujuan/);
    assert.match(info.text, /contoh\.com\/tujuan-lama/, 'the info page shows where it points now');
    assert.match(info.text, /Aktif/);
    assert.doesNotMatch(info.text, /Belum diisi/);
    const form = await holder(t).form(link);
    assert.match(form.text, /<h1[^>]*>Ubah tujuan barcode<\/h1>/);
    assert.match(form.text, /value="https:\/\/contoh\.com\/tujuan-lama"/, 'the form is pre-filled');
  });

  it('shows each kind of destination on the info page the way a person reads it', async () => {
    const wa = await pendingBarcode({ targetType: 'whatsapp', targetUrl: 'https://wa.me/6281234567890?text=Halo' });
    const info = (await holder(t).open(wa)).text;
    assert.match(info, /WhatsApp/);
    assert.match(info, /6281234567890/, 'the number, not the wa.me address');
    await t.reset();

    const mail = await pendingBarcode({ targetType: 'email', targetUrl: 'mailto:halo@contoh.co.id?subject=Tanya' });
    const mailInfo = (await holder(t).open(mail)).text;
    assert.match(mailInfo, /halo@contoh\.co\.id/);
    assert.doesNotMatch(mailInfo, /edit-now__open/, 'no "open in a new tab" button for mailto:');
  });

  it('only the form page accepts a save: posting to the info address does nothing', async () => {
    const link = await pendingBarcode();
    const res = await t.request().post(link).type('form').send(URL_FIELDS('https://contoh.com/salah-alamat'));
    assert.ok(res.status >= 400, `POST to the info page must be refused, got ${res.status}`);
    assert.equal(res.headers.location, undefined);
    assert.equal((await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'")).target_url, null);
  });

  it('every kind of dead link gets the same plain page, on both pages, and reveals nothing', async () => {
    await pendingBarcode();
    const wellFormedButUnknown = `/e/${'A'.repeat(43)}`;
    for (const path of ['/e/x', wellFormedButUnknown, `/e/${'A'.repeat(44)}`, `/e/${'A'.repeat(42)}!`, '/e/..%2F..%2Fadmin', `/e/${encodeURIComponent("' OR 1=1 --")}`]) {
      const attempts = [
        ['GET info', await holder(t).open(path)],
        ['GET form', await holder(t).form(path)],
        ['POST form', await holder(t).save(path, URL_FIELDS('https://contoh.com/x'))],
      ];
      for (const [what, res] of attempts) {
        assert.equal(res.status, 404, `${what} ${path}`);
        assert.match(res.text, /Link Edit Tidak Valid/, `${what} ${path}`);
        assert.doesNotMatch(res.text, /BR-000001|Menu Meja|postgres|SELECT|stack/i, `${what} ${path}`);
        assert.equal(res.headers['set-cookie'], undefined);
      }
    }
    assert.equal((await holder(t).open('/e')).status, 404);
    assert.equal((await holder(t).open(`/e/${'A'.repeat(43)}/lagi`)).status, 404);
    assert.equal((await holder(t).open(`/e/${'A'.repeat(43)}/edit/lagi`)).status, 404);
    assert.equal((await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'")).target_url, null);
  });

  it('saving fills in the destination at once: the printed QR redirects, the history says who and from where', async () => {
    const link = await pendingBarcode();
    assert.equal((await scan(t, 'BR-000001')).status, 200, 'still waiting');

    const res = await holder(t).save(link, URL_FIELDS('https://contoh.com/menu-meja-5'));
    assert.equal(res.status, 303, 'POST -> redirect -> GET: reloading the page does not re-submit');
    assert.equal(res.headers.location, `${link}?saved=1`, 'after saving, the person lands on the info page');
    assert.equal(res.headers['set-cookie'], undefined);

    const done = await holder(t).open(res.headers.location);
    assert.match(done.text, /Tujuan tersimpan/);
    assert.match(done.text, /Ubah tujuan/, 'the button now says "change"');
    assert.match(done.text, /contoh\.com\/menu-meja-5/, 'the info page shows the new destination');
    assert.match(done.text, /Aktif/, 'the badge follows the new state');
    const again = await holder(t).form(link);
    assert.match(again.text, /Ubah tujuan barcode/);
    assert.match(again.text, /value="https:\/\/contoh\.com\/menu-meja-5"/, 'the form shows what is saved');

    const ok = await scan(t, 'BR-000001');
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, 'https://contoh.com/menu-meja-5');

    const history = await t.db.rows('SELECT old_url, new_url, changed_by, changed_via, host(changed_ip) AS ip FROM barcode_history');
    assert.deepEqual(history.map((h) => ({ ...h })), [
      { old_url: null, new_url: 'https://contoh.com/menu-meja-5', changed_by: null, changed_via: 'edit_link', ip: '127.0.0.1' },
    ]);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM user_sessions')).n, 0);
  });

  it('the link keeps working for later changes, until the admin revokes it', async () => {
    const link = await pendingBarcode({ targetUrl: 'https://contoh.com/pertama' });
    assert.match((await holder(t).form(link)).text, /Ubah tujuan barcode/);
    await holder(t).save(link, URL_FIELDS('https://contoh.com/kedua'));
    await holder(t).save(link, URL_FIELDS('https://contoh.com/ketiga'));
    assert.equal((await scan(t, 'BR-000001')).headers.location, 'https://contoh.com/ketiga');
    const history = await t.db.rows('SELECT old_url, new_url FROM barcode_history ORDER BY id');
    assert.deepEqual(history.map((h) => [h.old_url, h.new_url]), [
      ['https://contoh.com/pertama', 'https://contoh.com/kedua'],
      ['https://contoh.com/kedua', 'https://contoh.com/ketiga'],
    ]);
  });

  it('saving the same destination again changes nothing and writes no history', async () => {
    const link = await pendingBarcode({ targetUrl: 'https://contoh.com/tetap' });
    const res = await holder(t).save(link, URL_FIELDS('https://contoh.com/tetap'));
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, `${link}?saved=0`);
    assert.match((await holder(t).open(res.headers.location)).text, /Tidak ada yang berubah/);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_history')).n, 0);
  });

  it('supports WhatsApp, email and phone destinations, pre-filled when the page is opened again', async () => {
    const link = await pendingBarcode();
    await holder(t).save(link, { target_type: 'whatsapp', target_value: '081234567890', target_extra: 'Halo!' });
    assert.equal((await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'")).target_url, 'https://wa.me/6281234567890?text=Halo!');
    const page = await holder(t).form(link);
    assert.match(page.text, /value="6281234567890"/);
    assert.match(page.text, /value="Halo!"/);
    assert.match(page.text, /name="target_type" value="whatsapp" checked/);

    await holder(t).save(link, { target_type: 'email', target_value: 'halo@contoh.co.id', target_extra: 'Tanya' });
    assert.equal((await t.db.one("SELECT target_type, target_url FROM barcodes WHERE code = 'BR-000001'")).target_url, 'mailto:halo@contoh.co.id?subject=Tanya');
    await holder(t).save(link, { target_type: 'phone', target_value: '0274123456' });
    const phone = await scan(t, 'BR-000001');
    assert.equal(phone.status, 200, 'tel: goes through the hand-off page');
    assert.match(phone.text, /tel:\+62274123456/);
  });

  it('refuses everything the admin form refuses, keeps what was typed, and changes nothing', async () => {
    const link = await pendingBarcode();
    const cases = [
      [URL_FIELDS('javascript:alert(1)'), /URL harus diawali http/],
      [URL_FIELDS('data:text/html;base64,PHNjcmlwdD4='), /URL harus diawali http/],
      [URL_FIELDS('ftp://example.com/x'), /URL harus diawali http/],
      [URL_FIELDS('https://user:pass@contoh.com/x'), /username atau password/],
      [URL_FIELDS('https://barcode.test/b/BR-000002'), /redirect berputar/],
      [URL_FIELDS(''), /URL tujuan wajib diisi/],
      [URL_FIELDS('   '), /URL tujuan wajib diisi/],
      [{ target_type: 'whatsapp', target_value: 'abc' }, /Nomor WhatsApp tidak valid/],
      [{ target_type: 'email', target_value: 'bukan-email' }, /Alamat email tidak valid/],
      [{ target_type: 'sms', target_value: '1' }, /Tipe tujuan tidak dikenal/],
      [{ target_type: 'whatsapp', target_value: '', target_extra: 'Halo' }, /Nomor WhatsApp tidak valid/],
      [URL_FIELDS(`https://contoh.com/${'a'.repeat(2100)}`), /terlalu panjang/],
    ];
    for (const [fields, message] of cases) {
      const res = await holder(t).save(link, fields);
      assert.equal(res.status, 422, JSON.stringify(fields).slice(0, 80));
      assert.match(res.text, message);
      assert.match(res.text, /Tujuan belum bisa disimpan/);
    }
    const kept = await holder(t).save(link, URL_FIELDS('ftp://tetap-ada.test'));
    assert.match(kept.text, /value="ftp:\/\/tetap-ada\.test"/, 'what was typed stays in the field');
    assert.ok(kept.text.includes(`action="${link}/edit"`), 'the person stays on the form page, which can be submitted again');
    assert.ok(kept.text.includes(`href="${link}"`), 'with a way back to the info page');
    const row = await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'");
    assert.equal(row.target_url, null);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_history')).n, 0);
  });

  it('a filled destination cannot be blanked through the link', async () => {
    const link = await pendingBarcode({ targetUrl: 'https://contoh.com/jangan-hilang' });
    assert.equal((await holder(t).save(link, URL_FIELDS(''))).status, 422);
    assert.equal((await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'")).target_url, 'https://contoh.com/jangan-hilang');
  });

  it('can touch the destination and NOTHING else, whatever else is sent along', async () => {
    const link = await pendingBarcode({ description: 'catatan admin' });
    const before = await t.db.one("SELECT name, description, status, expired_at, scan_count, edit_token, created_by, import_batch_id, code, id FROM barcodes WHERE code = 'BR-000001'");
    const res = await holder(t).save(link, {
      ...URL_FIELDS('https://contoh.com/sah'),
      name: 'DIRETAS',
      description: 'DIRETAS',
      status: 'inactive',
      expired_at: '2001-01-01T00:00',
      edit_token: 'A'.repeat(43),
      scan_count: '999',
      code: 'BR-999999',
      id: '77',
      created_by: '1',
    });
    assert.equal(res.status, 303);
    const after = await t.db.one("SELECT name, description, status, expired_at, scan_count, edit_token, created_by, import_batch_id, code, id, target_url FROM barcodes WHERE id = $1", [before.id]);
    const { target_url: target, ...unchanged } = after;
    assert.equal(target, 'https://contoh.com/sah');
    assert.deepEqual({ ...unchanged }, { ...before });
  });

  it('works for inactive and expired barcodes too, and says why scanners will not see the result yet', async () => {
    const inactive = await pendingBarcode({ status: 'inactive', targetUrl: 'https://contoh.com/a' });
    const page = await holder(t).open(inactive);
    assert.match(page.text, /sedang dinonaktifkan/);
    assert.equal((await holder(t).save(inactive, URL_FIELDS('https://contoh.com/b'))).status, 303);
    assert.equal((await scan(t, 'BR-000001')).status, 403, 'still inactive: the person cannot switch it on');

    await t.reset();
    const expired = await pendingBarcode({ expiredLocal: '2001-01-01 00:00:00', targetUrl: 'https://contoh.com/a' });
    assert.match((await holder(t).open(expired)).text, /Masa berlaku barcode ini sudah berakhir/);
    assert.equal((await scan(t, 'BR-000001')).status, 410);
  });

  it('a barcode name is escaped on both pages, and the ?saved= flag cannot be used to inject text', async () => {
    const link = await pendingBarcode({ name: '<img src=x onerror=alert(1)>' });
    const res = await holder(t).open(`${link}?saved=%3Cscript%3Ealert(1)%3C/script%3E`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('<img src=x'), 'name is HTML-escaped');
    assert.match(res.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.ok(!res.text.includes('alert(1)</script>'));
    assert.doesNotMatch(res.text, /Tujuan tersimpan|Tidak ada yang berubah/, 'unknown values show nothing');
    for (const evil of ['__proto__', 'constructor', 'toString', '1&saved=1', '1,0']) {
      assert.equal((await holder(t).open(`${link}?saved=${encodeURIComponent(evil)}`)).status, 200);
    }
    const form = await holder(t).form(link);
    assert.ok(!form.text.includes('<img src=x'));
    assert.match(form.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it('the info page confirms a save with a notice that comes only from the two known ?saved= values', async () => {
    const link = await pendingBarcode();
    assert.doesNotMatch((await holder(t).open(link)).text, /Tujuan tersimpan|Tidak ada yang berubah/, 'no notice on a plain visit');
    assert.match((await holder(t).open(`${link}?saved=1`)).text, /Tujuan tersimpan/);
    assert.match((await holder(t).open(`${link}?saved=0`)).text, /Tidak ada yang berubah/);
    assert.doesNotMatch((await t.request().get(`${link}/edit?saved=1`)).text, /Tujuan tersimpan/, 'the form page never shows it');
  });

  it('refuses oversized submissions before they reach the database', async () => {
    const link = await pendingBarcode();
    const res = await holder(t).save(link, URL_FIELDS(`https://contoh.com/${'a'.repeat(40000)}`));
    assert.equal(res.status, 413);
    assert.equal((await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'")).target_url, null);
  });

  it('robots.txt keeps crawlers away from edit links', async () => {
    assert.match((await t.request().get('/robots.txt')).text, /Disallow: \/e\//);
  });

  it('the QR printed BEFORE the destination existed works the moment it is filled in, byte for byte unchanged', async () => {
    await makeUser(t.ctx, { username: 'admin' });
    const admin = await loginAgent(t);
    await postForm(admin, '/admin/barcodes', { name: 'Stiker Rak A', target_type: 'url', target_value: '', status: 'active' }, { tokenPage: '/admin/barcodes/new' });
    const link = `/e/${await editTokenOf(t.ctx, 'BR-000001')}`;

    const printed = await getBuffer(admin, '/admin/barcodes/BR-000001/qr.png?download=1');
    const address = decode(printed);
    assert.equal(address, 'https://barcode.test/b/BR-000001', 'the QR only ever holds the system address');

    const before = await t.request().get(new URL(address).pathname);
    assert.equal(before.status, 200);
    assert.match(before.text, /Barcode Belum Diisi/);

    await holder(t).save(link, URL_FIELDS('https://contoh.com/rak-a'));
    const after = await t.request().get(new URL(address).pathname);
    assert.equal(after.status, 302);
    assert.equal(after.headers.location, 'https://contoh.com/rak-a');

    assert.ok((await getBuffer(admin, '/admin/barcodes/BR-000001/qr.png?download=1')).equals(printed), 'the printed image is still exactly the current QR');
  });

  it('edits made through the link show up in the admin screens, marked as "Link edit"', async () => {
    await makeUser(t.ctx, { username: 'admin' });
    const admin = await loginAgent(t);
    const link = await pendingBarcode();
    await holder(t).save(link, URL_FIELDS('https://contoh.com/dari-link'));

    for (const page of ['/admin/barcodes/BR-000001', '/admin/history', '/admin']) {
      const res = await admin.get(page);
      assert.match(res.text, /Link edit/, page);
      assert.match(res.text, /127\.0\.0\.1/, `${page} shows where the change came from`);
    }
    assert.match((await admin.get('/admin/history?q=dari-link')).text, /contoh\.com\/dari-link/);
  });

  it('concurrent saves through one link never corrupt the history chain', async () => {
    const link = await pendingBarcode();
    const urls = Array.from({ length: 8 }, (_, i) => `https://contoh.com/serentak-${i}`);
    const results = await Promise.all(urls.map((u) => holder(t).save(link, URL_FIELDS(u))));
    assert.ok(results.every((r) => r.status === 303));

    const history = await t.db.rows('SELECT old_url, new_url FROM barcode_history ORDER BY id');
    assert.equal(history.length, 8, 'each distinct change is recorded once');
    assert.equal(history[0].old_url, null);
    for (let i = 1; i < history.length; i += 1) assert.equal(history[i].old_url, history[i - 1].new_url, `row ${i} continues where row ${i - 1} ended`);
    assert.equal((await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'")).target_url, history.at(-1).new_url);
  });
});

describe('public edit link: rate limits, cache and privacy options', () => {
  it('throttles guessing: unknown links from one IP get 429 once the budget is used', async () => {
    const t = await startApp({ EDIT_LINK_INVALID_RATE_LIMIT_MAX: '3' });
    try {
      const statuses = [];
      for (let i = 0; i < 6; i += 1) statuses.push((await holder(t).open(`/e/${String(i).repeat(43)}`)).status);
      assert.deepEqual(statuses.slice(0, 3), [404, 404, 404]);
      assert.ok(statuses.slice(3).every((s) => s === 429), `after the budget: ${statuses.slice(3)}`);
      const limited = await holder(t).open(`/e/${'9'.repeat(43)}`);
      assert.match(limited.text, /Terlalu Banyak Permintaan/);
      assert.ok(limited.headers['retry-after']);
    } finally {
      await t.close();
    }
  });

  it('a person with a valid link never eats into the "unknown link" budget', async () => {
    const t = await startApp({ EDIT_LINK_INVALID_RATE_LIMIT_MAX: '2' });
    try {
      await insertBarcodes(t.ctx, [{ targetUrl: null }]);
      const link = `/e/${await editTokenOf(t.ctx, 'BR-000001')}`;
      for (let i = 0; i < 10; i += 1) assert.equal((await holder(t).open(link)).status, 200);
    } finally {
      await t.close();
    }
  });

  it('limits how often ONE link can save, so a leaked link cannot flood the history; other links are unaffected', async () => {
    const t = await startApp({ EDIT_LINK_SAVE_RATE_LIMIT_MAX: '3' });
    try {
      await insertBarcodes(t.ctx, [{ targetUrl: null }, { targetUrl: null }]);
      const a = `/e/${await editTokenOf(t.ctx, 'BR-000001')}`;
      const b = `/e/${await editTokenOf(t.ctx, 'BR-000002')}`;
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await holder(t).save(a, URL_FIELDS(`https://contoh.com/${i}`))).status);
      assert.deepEqual(statuses, [303, 303, 303, 429, 429]);
      assert.equal((await holder(t).save(b, URL_FIELDS('https://contoh.com/lain'))).status, 303);
      assert.equal((await holder(t).open(a)).status, 200, 'reading is not limited by the save budget');
      assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_history WHERE barcode_id = 1')).n, 3);
    } finally {
      await t.close();
    }
  });

  it('applies a general per-IP limit to the whole area', async () => {
    const t = await startApp({ EDIT_LINK_RATE_LIMIT_MAX: '3' });
    try {
      await insertBarcodes(t.ctx, [{ targetUrl: null }]);
      const link = `/e/${await editTokenOf(t.ctx, 'BR-000001')}`;
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await holder(t).open(link)).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    } finally {
      await t.close();
    }
  });

  it('with the redirect cache on, filling in a pending barcode takes effect immediately', async () => {
    const t = await startApp({ REDIRECT_CACHE_TTL_MS: '60000' });
    try {
      await insertBarcodes(t.ctx, [{ targetUrl: null }]);
      const link = `/e/${await editTokenOf(t.ctx, 'BR-000001')}`;
      assert.equal((await scan(t, 'BR-000001')).status, 200, 'pending page, now cached');
      assert.equal(t.ctx.cache.size, 1);
      await holder(t).save(link, URL_FIELDS('https://contoh.com/segera'));
      const res = await scan(t, 'BR-000001');
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, 'https://contoh.com/segera');
    } finally {
      await t.close();
    }
  });

  it('stores the caller IP behind a trusted proxy, and only its network part when IP_ANONYMIZE is on', async () => {
    const proxied = await startApp({ TRUST_PROXY: '1' });
    try {
      await insertBarcodes(proxied.ctx, [{ targetUrl: null }]);
      const link = `/e/${await editTokenOf(proxied.ctx, 'BR-000001')}`;
      await proxied.request().post(`${link}/edit`).set('X-Forwarded-For', '203.0.113.77').type('form').send(URL_FIELDS('https://contoh.com/a'));
      assert.equal((await proxied.db.one('SELECT host(changed_ip) AS ip FROM barcode_history')).ip, '203.0.113.77');
    } finally {
      await proxied.close();
    }
    const anon = await startApp({ TRUST_PROXY: '1', IP_ANONYMIZE: 'true' });
    try {
      await insertBarcodes(anon.ctx, [{ targetUrl: null }]);
      const link = `/e/${await editTokenOf(anon.ctx, 'BR-000001')}`;
      await anon.request().post(`${link}/edit`).set('X-Forwarded-For', '203.0.113.77').type('form').send(URL_FIELDS('https://contoh.com/a'));
      assert.equal((await anon.db.one('SELECT host(changed_ip) AS ip FROM barcode_history')).ip, '203.0.113.0');
    } finally {
      await anon.close();
    }
  });

  it('never writes the secret link into the logs (access log lines carry /e/[redacted])', async () => {
    const t = await startApp();
    const lines = [];
    const logger = pino({ level: 'info' }, { write: (line) => lines.push(line) });
    const logged = createContext(t.config, { logger });
    try {
      await insertBarcodes(t.ctx, [{ targetUrl: null }]);
      const token = await editTokenOf(t.ctx, 'BR-000001');
      const guess = 'G'.repeat(43);
      const api = supertest(createApp(logged));

      await api.get(`/e/${token}`);
      await api.get(`/e/${token}/edit`);
      await api.post(`/e/${token}/edit`).type('form').send(URL_FIELDS('https://contoh.com/log'));
      await api.get(`/e/${token}?saved=1`);
      await api.post(`/e/${token}/edit`).type('form').send(URL_FIELDS('javascript:alert(1)'));
      await api.get(`/e/${guess}`);
      await api.get(`/e/${guess}/edit`);
      await api.get('/e/tidak-valid');

      const log = lines.join('\n');
      assert.ok(log.includes('/e/[redacted]'), 'requests are logged, with the secret masked');
      assert.ok(log.includes('/e/[redacted]/edit'), 'the form page is covered too: the secret is the first segment');
      assert.ok(log.includes('destination changed through the edit link'), 'the change itself is logged (by code)');
      assert.ok(!log.includes(token), 'the real link is nowhere in the log');
      assert.ok(!log.includes(guess), 'not even a guessed one');
      assert.ok(!log.includes('tidak-valid'));
    } finally {
      await logged.close();
      await t.close();
    }
  });
});
