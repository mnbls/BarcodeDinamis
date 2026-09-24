// The admin side of Google Maps destinations: the create and edit forms offer "Ulasan Google Maps", the pasted link is
// turned into a Place ID (primary data) plus the review address (what scanners are sent to), and the database itself
// refuses inconsistent Maps data. Nothing here uses the network (see edit-link-public.test.js for the same idea).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createMapsResolver } from '../../src/modules/maps/maps.resolver.js';
import { createdCode, fakeGoogle, insertBarcodes, loginAgent, makeUser, mapsPlace, postForm, scan, startApp } from '../helpers/app.js';

describe('Google Maps destinations in the admin forms', () => {
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

  const row = (app = t, code = 'BR-000001') =>
    app.db.one('SELECT name, target_type, target_url, maps_place_id, maps_source_url, updated_at FROM barcodes WHERE code = $1', [code]);
  const historyCount = (app = t) => app.db.one('SELECT count(*)::int AS n FROM barcode_history').then((r) => r.n);

  const create = (agent, fields = {}) =>
    postForm(agent, '/admin/barcodes', { name: 'Warung Sate Pak Slamet', target_type: 'maps_review', target_value: mapsPlace(1).url, status: 'active', ...fields }, { tokenPage: '/admin/barcodes/new' });
  const edit = (agent, code, fields = {}) =>
    postForm(agent, `/admin/barcodes/${code}`, { name: 'Warung Sate Pak Slamet', target_type: 'maps_review', target_value: mapsPlace(1).url, status: 'active', ...fields }, { tokenPage: `/admin/barcodes/${code}/edit` });

  it('the create form offers "Ulasan Google Maps" next to the other destination types', async () => {
    const page = (await admin.get('/admin/barcodes/new')).text;
    assert.match(page, /name="target_type" value="maps_review"/);
    assert.match(page, /Ulasan Google Maps/);
    assert.match(page, /Link Google Maps/, 'the field texts for that type travel with the page');
    for (const type of ['url', 'whatsapp', 'email', 'phone']) assert.match(page, new RegExp(`name="target_type" value="${type}"`), `${type} is still there`);
  });

  it('creates a barcode from a long Maps link: Place ID as primary data, the review page as destination, the pasted link kept', async () => {
    const place = mapsPlace(1);
    const res = await create(admin);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/admin/barcodes/BR-000001');

    const stored = await row();
    assert.deepEqual(
      [stored.target_type, stored.target_url, stored.maps_place_id, stored.maps_source_url],
      ['maps_review', place.reviewUrl, place.placeId, place.url],
    );

    const detail = (await admin.get('/admin/barcodes/BR-000001')).text;
    for (const shown of ['Ulasan Google Maps', place.placeId, place.url, place.reviewUrl, 'Link Google Maps', 'Place ID']) assert.ok(detail.includes(shown), `the detail page shows ${shown}`);
    const scanned = await scan(t, 'BR-000001');
    assert.equal(scanned.status, 302);
    assert.equal(scanned.headers.location, place.reviewUrl);
    assert.match((await admin.get('/admin/barcodes')).text, /writereview\?placeid=/, 'the list shows the destination');
  });

  it('expands a short link through Google on the server, and remembers the short link that was pasted', async () => {
    const place = mapsPlace(2);
    const google = fakeGoogle({ [place.shortUrl]: place.url });
    const t2 = await startApp({}, { maps: google.maps });
    try {
      const admin2 = await (async () => {
        await makeUser(t2.ctx, { username: 'admin' });
        return loginAgent(t2);
      })();
      assert.equal((await create(admin2, { target_value: place.shortUrl })).status, 302);
      assert.deepEqual(google.calls.map((c) => c.url), [place.shortUrl]);
      const stored = await row(t2);
      assert.deepEqual([stored.maps_place_id, stored.target_url, stored.maps_source_url], [place.placeId, place.reviewUrl, place.shortUrl]);
    } finally {
      await t2.close();
    }
  });

  it('creates nothing when the link is refused or cannot be resolved, and shows the reason under the field', async () => {
    for (const [value, message] of [
      ['https://example.com/maps', /dari Google Maps/],
      ['javascript:alert(1)', /https/],
      ['https://www.google.com/maps/place/x/@1,2,17z', /ID lokasi tidak ditemukan/],
      [mapsPlace(1).shortUrl, /tidak bisa dibuka saat ini/], // offline
    ]) {
      const res = await create(admin, { target_value: value });
      assert.equal(res.status, 422, value);
      assert.match(res.text, message, value);
      assert.match(res.text, /Data belum bisa disimpan/);
      assert.ok(res.text.includes(`value="${value.replace(/&/g, '&amp;')}"`) || value.includes('"'), 'what was typed is kept');
      assert.match(res.text, /name="target_type" value="maps_review" checked/, 'the form stays on the Maps type');
    }
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0);
  });

  it('a blank Maps link is allowed on create ("fill in later"): a pending barcode that already knows it will be a Maps one', async () => {
    const res = await create(admin, { target_value: '' });
    assert.equal(res.status, 302);
    const code = createdCode(res);
    assert.match(code, /^BR-[2-9A-HJKMNP-Z]{8}$/, 'nothing to go to yet: a waiting card, so its code is random');
    assert.equal(res.headers.location, `/admin/barcodes/${code}#link-edit`);
    const stored = await row(t, code);
    assert.deepEqual([stored.target_type, stored.target_url, stored.maps_place_id, stored.maps_source_url], ['maps_review', null, null, null]);
  });

  it('the edit form is pre-filled with the Maps link that was pasted, not with the review address', async () => {
    const place = mapsPlace(1);
    await create(admin);
    const page = (await admin.get('/admin/barcodes/BR-000001/edit')).text;
    assert.match(page, /name="target_type" value="maps_review" checked/);
    assert.ok(page.includes(`value="${place.url}"`), 'the pasted link is in the field');
    assert.ok(!page.includes(place.reviewUrl) && !page.includes(place.placeId), 'the derived data is not');
  });

  it('saving with the SAME link (say, only renaming) does not ask Google again and writes no history', async () => {
    const place = mapsPlace(3);
    const google = fakeGoogle({ [place.shortUrl]: place.url });
    const t2 = await startApp({}, { maps: google.maps });
    try {
      await makeUser(t2.ctx, { username: 'admin' });
      const admin2 = await loginAgent(t2);
      await create(admin2, { target_value: place.shortUrl });
      assert.equal(google.calls.length, 1);

      const renamed = await edit(admin2, 'BR-000001', { name: 'Nama Baru', target_value: place.shortUrl });
      assert.equal(renamed.status, 302);
      assert.equal(google.calls.length, 1, 'the unchanged link is not resolved again');
      assert.equal((await row(t2)).name, 'Nama Baru');
      assert.equal(await historyCount(t2), 0);
    } finally {
      await t2.close();
    }
  });

  it('a different Maps link is resolved, replaces the Place ID, and is recorded in the history', async () => {
    const [first, second] = [mapsPlace(1), mapsPlace(2)];
    await create(admin);
    const res = await edit(admin, 'BR-000001', { target_value: second.url });
    assert.equal(res.status, 302);
    const stored = await row();
    assert.deepEqual([stored.maps_place_id, stored.target_url, stored.maps_source_url], [second.placeId, second.reviewUrl, second.url]);
    const history = await t.db.rows('SELECT old_url, new_url, changed_via FROM barcode_history');
    assert.deepEqual(history.map((h) => ({ ...h })), [{ old_url: first.reviewUrl, new_url: second.reviewUrl, changed_via: 'admin' }]);
    assert.equal((await scan(t, 'BR-000001')).headers.location, second.reviewUrl);
  });

  it('switching to another type clears the Place ID, and switching back to Maps sets it again', async () => {
    const place = mapsPlace(1);
    await create(admin);
    await edit(admin, 'BR-000001', { target_type: 'url', target_value: 'https://contoh.com/situs' });
    let stored = await row();
    assert.deepEqual([stored.target_type, stored.target_url, stored.maps_place_id, stored.maps_source_url], ['url', 'https://contoh.com/situs', null, null]);

    await edit(admin, 'BR-000001', { target_type: 'maps_review', target_value: place.url });
    stored = await row();
    assert.deepEqual([stored.target_type, stored.target_url, stored.maps_place_id], ['maps_review', place.reviewUrl, place.placeId]);
    assert.equal(await historyCount(), 2);
  });

  it('a Maps destination that is filled in cannot be blanked, and a bad new link changes nothing', async () => {
    const place = mapsPlace(1);
    await create(admin);
    const blank = await edit(admin, 'BR-000001', { target_value: '' });
    assert.equal(blank.status, 422);
    assert.match(blank.text, /wajib diisi/);
    const bad = await edit(admin, 'BR-000001', { target_value: 'https://example.com/maps' });
    assert.equal(bad.status, 422);
    assert.match(bad.text, /dari Google Maps/);
    const stored = await row();
    assert.deepEqual([stored.target_url, stored.maps_place_id], [place.reviewUrl, place.placeId]);
  });

  it('asks Google while NO database lock is held (an admin edit with a slow answer cannot stall scans of that barcode)', async () => {
    const place = mapsPlace(6);
    let release;
    let asked;
    const gate = new Promise((resolve) => { release = resolve; });
    const askedPromise = new Promise((resolve) => { asked = resolve; });
    const slow = createMapsResolver({
      fetch: async () => {
        asked();
        await gate;
        return { status: 302, headers: new Headers({ location: place.url }), body: { cancel: async () => {} } };
      },
    });
    const t2 = await startApp({}, { maps: slow });
    try {
      await makeUser(t2.ctx, { username: 'admin' });
      const admin2 = await loginAgent(t2);
      await insertBarcodes(t2.ctx, [{ name: 'Barcode Uji' }]);
      const csrfPage = '/admin/barcodes/BR-000001/edit';
      const saving = postForm(admin2, '/admin/barcodes/BR-000001', { name: 'Barcode Uji', target_type: 'maps_review', target_value: place.shortUrl, status: 'active' }, { tokenPage: csrfPage }).then((res) => res);
      await askedPromise;
      const outcome = await Promise.race([
        t2.db.query("UPDATE barcodes SET scan_count = scan_count + 1 WHERE code = 'BR-000001'").then(() => 'free'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 1500)),
      ]);
      assert.equal(outcome, 'free', 'the barcode row must stay free while Google is being asked');
      release();
      assert.equal((await saving).status, 302);
      assert.equal((await row(t2)).maps_place_id, place.placeId);
    } finally {
      release?.();
      await t2.close();
    }
  });

  it('shows in the export and in the history like any other destination', async () => {
    const [first, second] = [mapsPlace(1), mapsPlace(2)];
    await create(admin);
    await edit(admin, 'BR-000001', { target_value: second.url });
    const csv = (await admin.get('/admin/barcodes/export.csv')).text;
    assert.match(csv, /maps_review/);
    assert.ok(csv.includes(second.reviewUrl));
    const history = (await admin.get('/admin/history')).text;
    assert.ok(history.includes(first.reviewUrl) && history.includes(second.reviewUrl));
  });

  it('the CSV import still creates plain URL barcodes only (a Maps type in the file is not a way around the resolver)', async () => {
    const csv = ['name,target_url,target_type', `Toko,${mapsPlace(1).url},maps_review`].join('\n');
    const agent = admin;
    const token = (await agent.get('/admin/import')).text.match(/name="_csrf" value="([^"]+)"/)[1];
    const res = await agent.post('/admin/import').field('_csrf', token).attach('file', Buffer.from(csv), 'data.csv');
    assert.equal(res.status, 302);
    const stored = await row();
    assert.deepEqual([stored.target_type, stored.maps_place_id], ['url', null], 'imported as an ordinary website link');
  });
});

describe('the database refuses inconsistent Maps data (defence in depth)', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
  });

  const place = mapsPlace(1);
  const insert = (type, url, placeId, source = null) =>
    t.db.query(
      "INSERT INTO barcodes (code, name, target_type, target_url, maps_place_id, maps_source_url) VALUES ('BR-X', 'x', $1, $2, $3, $4)",
      [type, url, placeId, source],
    );

  it('accepts a consistent Maps barcode, and a pending one without a Place ID', async () => {
    await insert('maps_review', place.reviewUrl, place.placeId, place.url);
    await t.db.query("DELETE FROM barcodes WHERE code = 'BR-X'");
    await insert('maps_review', null, null);
    await t.db.query("DELETE FROM barcodes WHERE code = 'BR-X'");
    await insert('url', 'https://contoh.com/x', null);
  });

  it('refuses a Place ID on anything but a filled Maps barcode, and a filled Maps barcode without one', async () => {
    await assert.rejects(insert('url', 'https://contoh.com/x', place.placeId), /barcodes_maps_consistency_check/);
    await assert.rejects(insert('maps_review', null, place.placeId), /barcodes_maps_consistency_check/);
    await assert.rejects(insert('maps_review', place.reviewUrl, null), /barcodes_maps_consistency_check/);
  });

  it('refuses a malformed Place ID, an unknown type, and an oversized source link', async () => {
    for (const bad of ['', 'ChIJshort', 'xxxx1234567890123456789012', `${place.placeId}x`, 'ChIJ!!!!!!!!!!!!!!!!!!!!!!!']) {
      await assert.rejects(insert('maps_review', place.reviewUrl, bad), /barcodes_maps_place_id_check|barcodes_maps_consistency_check/, bad);
    }
    await assert.rejects(insert('maps_reviews', place.reviewUrl, null), /barcodes_target_type_check/, 'an unknown type (no Place ID, so only the type check applies)');
    await assert.rejects(insert('maps_review', place.reviewUrl, place.placeId, `https://maps.app.goo.gl/${'a'.repeat(2100)}`), /barcodes_maps_source_len_check/);
  });

  it('still refuses dangerous destinations for Maps barcodes (the scheme check is unchanged)', async () => {
    await assert.rejects(insert('maps_review', 'javascript:alert(1)', place.placeId), /barcodes_target_scheme_check/);
  });
});
