// The admin side of "fill in later": creating barcodes without a destination, the edit link that goes with each barcode,
// what a scan of such a barcode does, and who may see or manage the link. What the person holding the link does is in
// edit-link-public.test.js.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as repo from '../../src/modules/barcodes/barcodes.repo.js';
import { createdCode, editTokenOf, insertBarcodes, linkHolder as holder, loginAgent, makeUser, mapsPlace, postForm, scan, startApp, uploadCsv, waitingCard } from '../helpers/app.js';

/** The one field of the public form: the Google Maps link. */
const MAPS = (n = 1) => ({ maps_link: mapsPlace(n).url });

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

  /** Through the create form, as the browser posts it (an empty destination when none is typed). */
  const create = (fields = {}) =>
    postForm(admin, '/admin/barcodes', { name: 'Stiker Inventaris Lab', description: 'Isinya menyusul', target_type: 'url', target_value: '', status: 'active', ...fields }, { tokenPage: '/admin/barcodes/new' });
  /** A barcode without a destination and with a SEQUENTIAL code (BR-000001), made directly: for tests about the link itself. */
  const pendingBarcode = () => insertBarcodes(t.ctx, [{ name: 'Stiker Inventaris Lab', description: 'Isinya menyusul', targetUrl: null }]);
  const RANDOM_CODE = /^BR-[2-9A-HJKMNP-Z]{8}$/;

  it('the create form does not ask for a link: it explains what happens instead, and keeps the destination tucked away', async () => {
    const page = (await admin.get('/admin/barcodes/new')).text;
    assert.match(page, /Tidak perlu mengisi link/);
    assert.match(page, /halaman aktivasi/);
    assert.match(page, /<details class="optional-target">/, 'closed by default');
    assert.doesNotMatch(page, /<details class="optional-target" open>/);
    assert.doesNotMatch(page, /Belum tahu tujuannya/, 'that question belongs to editing an unfilled barcode');
    assert.ok(page.indexOf('optional-target') < page.indexOf('name="target_type"'), 'the destination fields are inside the closed section');
  });

  it('creating with only a name works: the barcode exists at once, with a random code and its own edit link', async () => {
    const res = await postForm(admin, '/admin/barcodes', { name: 'Kartu Baru' }, { tokenPage: '/admin/barcodes/new' });
    assert.equal(res.status, 302);
    const code = createdCode(res);
    assert.match(code, RANDOM_CODE, 'a random code although CODE_MODE is sequential here');
    assert.equal(res.headers.location, `/admin/barcodes/${code}#link-edit`);
    const row = await t.db.one('SELECT target_url, status, edit_token FROM barcodes WHERE code = $1', [code]);
    assert.deepEqual([row.target_url, row.status], [null, 'active']);
    assert.match(row.edit_token, /^[A-Za-z0-9_-]{43}$/);
  });

  it('the destination section reopens by itself when it holds input or an error', async () => {
    const wrong = await create({ target_value: 'javascript:alert(1)' });
    assert.equal(wrong.status, 422);
    assert.match(wrong.text, /<details class="optional-target" open>/, 'the error must be visible');
    assert.match(wrong.text, /javascript:alert\(1\)/, 'what was typed is kept');
    const clean = await postForm(admin, '/admin/barcodes', { name: '' }, { tokenPage: '/admin/barcodes/new' });
    assert.equal(clean.status, 422);
    assert.doesNotMatch(clean.text, /<details class="optional-target" open>/, 'a name error does not open it');
  });

  it('creates a barcode with no destination, and gives it its own edit link', async () => {
    const res = await create();
    assert.equal(res.status, 302);
    const code = createdCode(res);
    assert.match(code, RANDOM_CODE);
    assert.equal(res.headers.location, `/admin/barcodes/${code}#link-edit`);

    const row = await t.db.one('SELECT target_url, target_type, edit_token, status FROM barcodes WHERE code = $1', [code]);
    assert.equal(row.target_url, null);
    assert.equal(row.target_type, 'url');
    assert.equal(row.status, 'active');
    assert.match(row.edit_token, /^[A-Za-z0-9_-]{43}$/, '256 random bits, URL-safe');

    const detail = await admin.get(`/admin/barcodes/${code}`);
    assert.equal(detail.status, 200);
    assert.match(detail.text, /Barcode dibuat dan langsung siap dicetak/, 'toast after the redirect');
    assert.match(detail.text, /Menunggu aktivasi/, 'says what a scan does');
    assert.match(detail.text, /Halaman aktivasi \(link edit\)/, 'and where it leads, in the flow');
    assert.match(detail.text, /Belum diisi/);
    assert.match(detail.text, /Link edit tanpa login/);
    assert.match(detail.text, /tidak perlu dikirim terpisah/);
    assert.ok(detail.text.includes(`https://barcode.test/e/${row.edit_token}`), 'the admin can copy the link');
    assert.match(detail.text, /Buka halaman edit/);
  });

  it('a barcode created with a destination keeps following CODE_MODE (sequential here) and is not a waiting card', async () => {
    const res = await create({ target_value: 'https://contoh.com/langsung' });
    assert.equal(createdCode(res), 'BR-000001');
    const detail = (await admin.get('/admin/barcodes/BR-000001')).text;
    assert.doesNotMatch(detail, /Menunggu aktivasi|Halaman aktivasi \(link edit\)/);
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

  describe('scanning a barcode that has no destination yet', () => {
    it('takes the scanner to the ACTIVATION page (its own edit link): private, and not counted as a scan', async () => {
      const code = createdCode(await create());
      const token = await editTokenOf(t.ctx, code);

      const res = await scan(t, code);
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, `/e/${token}`);
      assert.match(res.headers['cache-control'], /no-store/, 'the address is a secret: never cached');
      assert.match(res.headers['x-robots-tag'], /noindex/);
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
      assert.equal(res.headers['set-cookie'], undefined);
      assert.equal((await t.db.one('SELECT scan_count FROM barcodes WHERE code = $1', [code])).scan_count, 0, 'an activation visit is not a scan');
      assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_scans')).n, 0);

      const page = await holder(t).open(res.headers.location);
      assert.equal(page.status, 200);
      assert.match(page.text, /Aktifkan kartu review Anda/);
      assert.match(page.text, /memindai kartu ini membuka halaman ini/, 'the page says why the owner ended up here');
    });

    it('does it for a HEAD request too (link previewers), and still counts nothing', async () => {
      const code = createdCode(await create());
      const res = await t.request().head(`/b/${code}`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, `/e/${await editTokenOf(t.ctx, code)}`);
      assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_scans')).n, 0);
    });

    it('never hands out the link when the code can be guessed by counting: "Barcode Belum Diisi", nothing leaked', async () => {
      await pendingBarcode(); // BR-000001: sequential
      const res = await scan(t, 'BR-000001');
      assert.equal(res.status, 200);
      assert.match(res.text, /Barcode Belum Diisi/);
      assert.equal(res.headers.location, undefined, 'there is nowhere to send the scanner');
      assert.match(res.headers['cache-control'], /no-store/);
      assert.match(res.headers['x-robots-tag'], /noindex/);
      assert.ok(!res.text.includes('/e/'), 'the edit link is never shown to people who scan');
      assert.ok(!res.text.includes(await editTokenOf(t.ctx, 'BR-000001')));
      assert.equal((await t.db.one('SELECT scan_count FROM barcodes')).scan_count, 0, 'a visit that leads nowhere is not a scan');
      assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_scans')).n, 0);
    });

    it('cannot be used to collect the links of many cards: counting through the codes yields nothing', async () => {
      await insertBarcodes(t.ctx, Array.from({ length: 30 }, (_, i) => ({ name: `Kartu ${i}`, targetUrl: null })));
      const tokens = new Set((await t.db.rows('SELECT edit_token FROM barcodes')).map((r) => r.edit_token));
      assert.equal(tokens.size, 30);
      for (let n = 1; n <= 30; n += 1) {
        const res = await t.request().get(`/b/BR-${String(n).padStart(6, '0')}`);
        assert.equal(res.status, 200, `BR-${n}`);
        assert.equal(res.headers.location, undefined);
        for (const token of tokens) assert.ok(!res.text.includes(token));
      }
    });

    it('shows "Barcode Belum Diisi" as well when the link has been revoked', async () => {
      const code = createdCode(await create());
      await postForm(admin, `/admin/barcodes/${code}/edit-link/revoke`, {}, { tokenPage: '/admin' });
      const res = await scan(t, code);
      assert.equal(res.status, 200);
      assert.match(res.text, /Barcode Belum Diisi/);
      assert.equal(res.headers.location, undefined);
    });

    it('follows a REPLACED link at once: the old address is dead, the scan leads to the new one', async () => {
      const code = createdCode(await create());
      const first = await editTokenOf(t.ctx, code);
      assert.equal((await scan(t, code)).headers.location, `/e/${first}`);
      await postForm(admin, `/admin/barcodes/${code}/edit-link`, {}, { tokenPage: '/admin' });
      const second = await editTokenOf(t.ctx, code);
      assert.notEqual(second, first);
      assert.equal((await scan(t, code)).headers.location, `/e/${second}`);
      assert.equal((await holder(t).open(`/e/${first}`)).status, 404);
    });

    it('is not held back by the redirect cache: the token is looked up on every scan', async () => {
      const cached = await startApp({ REDIRECT_CACHE_TTL_MS: '60000' });
      try {
        await makeUser(cached.ctx, { username: 'admin' });
        const admin2 = await loginAgent(cached);
        const code = createdCode(await postForm(admin2, '/admin/barcodes', { name: 'Kartu Cache' }, { tokenPage: '/admin/barcodes/new' }));
        const first = await editTokenOf(cached.ctx, code);
        assert.equal((await scan(cached, code)).headers.location, `/e/${first}`, 'the pending row is now cached');
        await postForm(admin2, `/admin/barcodes/${code}/edit-link`, {}, { tokenPage: '/admin' });
        assert.equal((await scan(cached, code)).headers.location, `/e/${await editTokenOf(cached.ctx, code)}`, 'a cached row must not pin the old link');
        await postForm(admin2, `/admin/barcodes/${code}/edit-link/revoke`, {}, { tokenPage: '/admin' });
        assert.equal((await scan(cached, code)).status, 200, 'and revoking takes effect at once too');
      } finally {
        await cached.close();
      }
    });

    it('leaves the state checks in charge: inactive and expired barcodes never hand out the link', async () => {
      const inactive = await waitingCard(t, { status: 'inactive' });
      const expired = await waitingCard(t, { expiredLocal: '2001-01-01 00:00:00' });
      const off = await scan(t, inactive.code);
      assert.equal(off.status, 403);
      assert.match(off.text, /Barcode Tidak Aktif/);
      assert.equal(off.headers.location, undefined);
      const old = await scan(t, expired.code);
      assert.equal(old.status, 410);
      assert.match(old.text, /Barcode Sudah Tidak Berlaku/);
      assert.equal(old.headers.location, undefined);
    });

    it('stops as soon as Maps is entered: the scan goes to the review page and the link is never revealed again', async () => {
      const card = await waitingCard(t);
      assert.equal((await scan(t, card.code)).headers.location, card.link);
      const place = mapsPlace(1);
      assert.equal((await holder(t).save(card.link, MAPS(1))).status, 303);
      const after = await scan(t, card.code);
      assert.equal(after.status, 302);
      assert.equal(after.headers.location, place.reviewUrl);
      assert.ok(!String(after.headers.location).includes(card.token));
      assert.equal((await t.db.one('SELECT scan_count FROM barcodes WHERE code = $1', [card.code])).scan_count, 1, 'only the scan after activation counts');
    });
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
    await pendingBarcode();
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

    await insertBarcodes(t.ctx, [{ name: 'Kosong', targetUrl: null }]); // BR-000002
    const rename = await postForm(admin, '/admin/barcodes/BR-000002', { name: 'Kosong (diganti)', target_type: 'url', target_value: '', status: 'active' }, { tokenPage: '/admin/barcodes/BR-000002/edit' });
    assert.equal(rename.status, 302);
    const row = await t.db.one("SELECT name, target_url FROM barcodes WHERE code = 'BR-000002'");
    assert.deepEqual({ ...row }, { name: 'Kosong (diganti)', target_url: null });
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_history')).n, 0, 'nothing about the destination changed');
  });

  it('the edit form explains that the destination is optional only while it is', async () => {
    await insertBarcodes(t.ctx, [{ name: 'Kosong', targetUrl: null }, { name: 'Terisi', targetUrl: 'https://contoh.com/terisi' }]);
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
    await pendingBarcode();
    const first = await editTokenOf(t.ctx, 'BR-000001');

    const replaced = await postForm(admin, '/admin/barcodes/BR-000001/edit-link', {}, { tokenPage: '/admin' });
    assert.equal(replaced.status, 302);
    assert.equal(replaced.headers.location, '/admin/barcodes/BR-000001#link-edit');
    const second = await editTokenOf(t.ctx, 'BR-000001');
    assert.notEqual(second, first);
    assert.equal((await holder(t).open(`/e/${first}`)).status, 404, 'the replaced link is dead');
    assert.equal((await holder(t).save(`/e/${first}`, MAPS(1))).status, 404, 'and cannot save either');
    assert.equal((await holder(t).open(`/e/${second}`)).status, 200);

    const revoked = await postForm(admin, '/admin/barcodes/BR-000001/edit-link/revoke', {}, { tokenPage: '/admin' });
    assert.equal(revoked.status, 302);
    assert.equal(await editTokenOf(t.ctx, 'BR-000001'), null);
    assert.equal((await holder(t).open(`/e/${second}`)).status, 404);
    assert.equal((await holder(t).save(`/e/${second}`, MAPS(2))).status, 404);
    assert.match((await admin.get('/admin/barcodes/BR-000001')).text, /Barcode ini belum punya link edit/);
    assert.equal((await t.db.one("SELECT target_url FROM barcodes WHERE code = 'BR-000001'")).target_url, null, 'nothing was saved through the dead links');

    await postForm(admin, '/admin/barcodes/BR-000001/edit-link', {}, { tokenPage: '/admin' });
    const third = await editTokenOf(t.ctx, 'BR-000001');
    assert.match(third, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await holder(t).open(`/e/${third}`)).status, 200);
  });

  it('rotating or revoking the link is not an edit of the barcode: updated_at stays', async () => {
    await pendingBarcode();
    const before = (await t.db.one("SELECT updated_at FROM barcodes WHERE code = 'BR-000001'")).updated_at;
    await new Promise((r) => setTimeout(r, 15));
    await postForm(admin, '/admin/barcodes/BR-000001/edit-link', {}, { tokenPage: '/admin' });
    await postForm(admin, '/admin/barcodes/BR-000001/edit-link/revoke', {}, { tokenPage: '/admin' });
    assert.equal((await t.db.one("SELECT updated_at FROM barcodes WHERE code = 'BR-000001'")).updated_at.getTime(), before.getTime());
  });

  it('deleting the barcode kills its link', async () => {
    await pendingBarcode();
    const link = `/e/${await editTokenOf(t.ctx, 'BR-000001')}`;
    await postForm(admin, '/admin/barcodes/BR-000001/delete', {}, { tokenPage: '/admin' });
    assert.equal((await holder(t).open(link)).status, 404);
  });

  it('a read-only viewer never sees the link, and cannot issue or revoke one', async () => {
    await pendingBarcode();
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

    // a card whose scan hands the link out: the viewer learns what a scan does, never the link
    const card = await waitingCard(t);
    const cardPage = await viewer.get(`/admin/barcodes/${card.code}`);
    assert.match(cardPage.text, /Menunggu aktivasi/);
    assert.ok(!cardPage.text.includes(card.token), 'the secret is not in the page, not even to explain the activation');

    // ...and the token is not in any list or export they can open either
    assert.ok(!(await viewer.get('/admin/barcodes')).text.includes(token));
    assert.ok(!(await viewer.get('/admin/barcodes/export.csv')).text.includes(token));
  });

  it('the token is not in the list, the export, the edit form or the print page, even for admins', async () => {
    const code = createdCode(await create()); // a waiting card: its scan hands the link out, but no PAGE may print it
    const token = await editTokenOf(t.ctx, code);
    for (const page of ['/admin', '/admin/barcodes', '/admin/barcodes/export.csv', `/admin/barcodes/${code}/edit`, `/admin/barcodes/${code}/print`, '/admin/barcodes/new', '/admin/history', '/admin/analytics']) {
      assert.ok(!(await admin.get(page)).text.includes(token), `${page} must not print the secret`);
    }
  });

  it('nobody can issue or revoke a link without being signed in', async () => {
    await pendingBarcode();
    const token = await editTokenOf(t.ctx, 'BR-000001');
    const anon = t.request();
    assert.equal((await anon.post('/admin/barcodes/BR-000001/edit-link').type('form').send({})).status, 403, 'no CSRF token');
    assert.equal((await anon.post('/admin/barcodes/BR-000001/edit-link/revoke').type('form').send({})).status, 403);
    assert.equal(await editTokenOf(t.ctx, 'BR-000001'), token);
  });
});
