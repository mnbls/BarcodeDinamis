// What a person holding a public edit link sees and can do: an INFO page (/e/{token}) and a form page (/e/{token}/edit)
// with ONE empty field for their Google Maps link. Saving turns that link into a Place ID and points the barcode at the
// Google review page of that place. Nothing here uses the network: `offlineMaps` (the default) resolves long links
// without a request and fails short ones, and `fakeGoogle` plays Google's short-link service where a test needs it.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import jsQR from 'jsqr';
import pino from 'pino';
import { PNG } from 'pngjs';
import supertest from 'supertest';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { createMapsResolver } from '../../src/modules/maps/maps.resolver.js';
import { createdCode, editTokenOf, fakeGoogle, getBuffer, insertBarcodes, linkHolder as holder, loginAgent, makeUser, mapsPlace, offlineMaps, postForm, scan, startApp, waitingCard } from '../helpers/app.js';

const decode = (buffer) => {
  const png = PNG.sync.read(buffer);
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
};

const EMPTY_FIELD = /id="maps_link" name="maps_link" type="text" value=""/;

describe('public edit link: the info page and the Google Maps form', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
  });

  const pendingBarcode = async (fields = {}, app = t) => {
    await insertBarcodes(app.ctx, [{ name: 'Warung Sate Pak Slamet', description: 'RAHASIA-CATATAN-ADMIN', targetUrl: null, ...fields }]);
    return `/e/${await editTokenOf(app.ctx, 'BR-000001')}`;
  };
  /** A barcode that already leads to the review page of `place`. */
  const mapsBarcode = (place = mapsPlace(1), fields = {}, app = t) =>
    pendingBarcode({ targetType: 'maps_review', targetUrl: place.reviewUrl, mapsPlaceId: place.placeId, mapsSourceUrl: place.url, ...fields }, app);
  const barcodeRow = (app = t) =>
    app.db.one("SELECT target_type, target_url, maps_place_id, maps_source_url, name, description, status, expired_at, scan_count, edit_token FROM barcodes WHERE code = 'BR-000001'");

  /** What both pages have in common: nothing to steal or ride, nothing cached or indexed, nothing private shown. */
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

  describe('the two pages', () => {
    it('the link opens the ACTIVATION page without any login: the card, its status and the steps, no form', async () => {
      const link = await pendingBarcode();
      const res = await holder(t).open(link);
      assertPrivate(res);

      assert.match(res.text, /<title>Aktivasi kartu \| Riview Yuk<\/title>/, 'the person holding a card sees the card brand, not the admin panel name');
      assert.match(res.text, /<h1[^>]*>Aktifkan kartu review Anda<\/h1>/);
      assert.match(res.text, /BR-000001/);
      assert.match(res.text, /Warung Sate Pak Slamet/);
      assert.match(res.text, /Belum aktif/, 'the card says it is not active yet');
      assert.match(res.text, /rv-card__qr/, 'shows the QR so the person knows which card this is');
      assert.ok(res.text.includes(`href="${link}/edit"`), 'a button leads to the form page');
      assert.match(res.text, /Aktifkan kartu/);
      assert.match(res.text, /Masukkan Maps/, 'the current step');
      assert.match(res.text, /aria-current="step"/, 'the step the person is at is marked');
      assert.equal((res.text.match(/rv-step is-done/g) ?? []).length, 1, 'only "Kartu terdaftar" is done');
      assert.doesNotMatch(res.text, /<form|name="maps_link"|Simpan|Ubah tujuan|Isi tujuan/, 'the form is NOT on this page, and the old wording is gone');
      assert.doesNotMatch(res.text, /Dynamic Barcode/, 'the admin product name does not appear on the card pages');
      assert.equal((await t.db.one('SELECT count(*)::int AS n FROM user_sessions')).n, 0, 'no session row either');
    });

    it('the FORM is one field for the Google Maps link, on a page of its own, and it opens EMPTY', async () => {
      const link = await pendingBarcode();
      const res = await holder(t).form(link);
      assertPrivate(res);

      assert.match(res.text, /<title>Masukkan Maps \| Riview Yuk<\/title>/);
      assert.match(res.text, /<h1[^>]*>Masukkan Maps<\/h1>/);
      assert.match(res.text, /Langkah 2 dari 3/, 'it is the second of the three activation steps');
      assert.match(res.text, /Link Google Maps/);
      assert.match(res.text, /BR-000001/, 'still says which barcode this is');
      assert.match(res.text, /Warung Sate Pak Slamet/);
      assert.ok(res.text.includes(`action="${link}/edit"`), 'it submits to its own address');
      assert.match(res.text, EMPTY_FIELD, 'nothing is pre-filled');
      assert.match(res.text, /Simpan/);
      assert.ok(res.text.includes(`href="${link}"`), 'a way back to the info page (Batal and the link at the top)');
      assert.doesNotMatch(res.text, /name="target_type"|name="target_value"|type-grid|URL tujuan|Ubah tujuan|Isi tujuan/, 'no destination types, no "change destination" wording');
      assert.doesNotMatch(res.text, /rv-card|rv-steps|badge/, 'the card and its status live on the activation page');
    });

    it('the form is EMPTY even when Maps is already saved (or an ordinary website is), and it never prints a stored address', async () => {
      const place = mapsPlace(3);
      const saved = await holder(t).form(await mapsBarcode(place));
      assert.match(saved.text, EMPTY_FIELD);
      for (const secret of [place.placeId, place.reviewUrl, place.url, 'placeid=', 'writereview']) assert.ok(!saved.text.includes(secret), `the form must not contain ${secret}`);

      await t.reset();
      const website = await holder(t).form(await pendingBarcode({ targetUrl: 'https://contoh.com/situs-lama' }));
      assert.match(website.text, EMPTY_FIELD);
      assert.ok(!website.text.includes('contoh.com/situs-lama'));
    });

    it('the activation page says the card is active once Maps is connected and offers to check it, but prints no address', async () => {
      const place = mapsPlace(2);
      const link = await mapsBarcode(place);
      const res = await holder(t).open(link);
      assertPrivate(res);
      assert.match(res.text, /<h1[^>]*>Kartu review Anda sudah aktif<\/h1>/);
      assert.match(res.text, /Maps terhubung/);
      assert.match(res.text, /Cek lokasi/);
      assert.match(res.text, /Lihat halaman ulasan/);
      assert.match(res.text, /Ganti lokasi Maps/, 'the way back to the form, worded for a card that is already active');
      assert.ok(res.text.includes(`href="${link}/edit"`));
      assert.ok(res.text.includes(`href="${place.url}"`), 'the buttons open the place and its review page');
      assert.ok(res.text.includes(`href="${place.reviewUrl}"`));
      assert.equal((res.text.match(/rv-step is-done/g) ?? []).length, 3, 'all three steps are done');
      assert.doesNotMatch(res.text, /aria-current="step"/, 'nothing left to do');
      assert.doesNotMatch(res.text, />[^<]*(ChIJ|google\.com|goo\.gl|writereview)[^<]*</, 'no address, no Place ID as visible text');
      assert.doesNotMatch(res.text, /Belum aktif|Aktifkan kartu/);
    });

    it('a barcode with another kind of destination (set by the admin) is described, not printed', async () => {
      const res = await holder(t).open(await pendingBarcode({ targetUrl: 'https://contoh.com/situs-lama' }));
      assertPrivate(res);
      assert.match(res.text, /tujuan lain yang diatur pengelola/);
      assert.ok(!res.text.includes('contoh.com/situs-lama'), 'the address is not shown');
      assert.doesNotMatch(res.text, /terhubung/i);
      assert.match(res.text, /Aktifkan kartu/, 'Maps is still to be entered');
    });

    it('says why scanners will not see the result yet when the barcode is inactive, expired or still empty', async () => {
      const inactive = await holder(t).open(await pendingBarcode({ status: 'inactive', targetUrl: 'https://contoh.com/a' }));
      assert.match(inactive.text, /sedang dinonaktifkan/);
      assert.match(inactive.text, /Nonaktif/);
      await t.reset();
      const expired = await holder(t).open(await pendingBarcode({ expiredLocal: '2001-01-01 00:00:00', targetUrl: 'https://contoh.com/a' }));
      assert.match(expired.text, /Masa berlaku kartu ini sudah berakhir/);
      assert.match(expired.text, /Kedaluwarsa/);
      await t.reset();
      const pending = await holder(t).open(await pendingBarcode());
      assert.match(pending.text, /Sampai Maps dimasukkan, pemindai melihat halaman "Barcode Belum Diisi"/);
    });

    it('a card whose scan opens this page says so, and one whose scan does not keeps the older wording', async () => {
      const card = await waitingCard(t);
      const opens = await holder(t).open(card.link);
      assert.match(opens.text, /Sebelum itu, memindai kartu ini membuka halaman ini/);
      assert.doesNotMatch(opens.text, /Barcode Belum Diisi/);

      const plain = await holder(t).open(await pendingBarcode()); // a sequential code: its scan shows the plain notice
      assert.match(plain.text, /Sampai Maps dimasukkan, pemindai melihat halaman "Barcode Belum Diisi"/);
      assert.doesNotMatch(plain.text, /membuka halaman ini/);
    });

    it('Maps connected but the card switched off or expired: the steps do not claim it is ready to scan', async () => {
      const place = mapsPlace(4);
      for (const [label, fields, alertText] of [
        ['inactive', { status: 'inactive' }, /sedang dinonaktifkan/],
        ['expired', { expiredLocal: '2001-01-01 00:00:00' }, /Masa berlaku kartu ini sudah berakhir/],
      ]) {
        await t.reset();
        const res = await holder(t).open(await mapsBarcode(place, fields));
        assert.match(res.text, /<h1[^>]*>Maps sudah terhubung<\/h1>/, label);
        assert.match(res.text, alertText, label);
        assert.equal((res.text.match(/rv-step is-done/g) ?? []).length, 2, `${label}: registered and connected, but not yet ready to scan`);
        assert.match(res.text, /Setelah kartu aktif kembali/, label);
        assert.doesNotMatch(res.text, /sudah aktif/, label);
      }
    });

    it('the card brand is a setting (BRAND_NAME) and never replaces the admin panel name', async () => {
      const branded = await startApp({ BRAND_NAME: 'Ulasan Kita' });
      try {
        await branded.reset();
        const link = await pendingBarcode({}, branded);
        for (const page of [link, `${link}/edit`]) {
          const res = await holder(branded).open(page);
          assert.match(res.text, /<title>[^<]+ \| Ulasan Kita<\/title>/, page);
          assert.ok(res.text.includes('Ulasan Kita</span>'), `${page}: the brand next to the star`);
          assert.doesNotMatch(res.text, /Riview Yuk|Dynamic Barcode/, page);
        }
        await makeUser(branded.ctx, { username: 'admin' });
        const admin = await loginAgent(branded);
        assert.match((await admin.get('/admin')).text, /\| Dynamic Barcode<\/title>/, 'the admin panel keeps its own name');
      } finally {
        await branded.close();
      }
    });

    it('only the form page accepts a save: posting to the info address does nothing', async () => {
      const link = await pendingBarcode();
      const res = await t.request().post(link).type('form').send({ maps_link: mapsPlace(1).url });
      assert.ok(res.status >= 400, `POST to the info page must be refused, got ${res.status}`);
      assert.equal(res.headers.location, undefined);
      assert.equal((await barcodeRow()).target_url, null);
    });

    it('every kind of dead link gets the same plain page, on both pages, and reveals nothing', async () => {
      await pendingBarcode();
      const wellFormedButUnknown = `/e/${'A'.repeat(43)}`;
      for (const path of ['/e/x', wellFormedButUnknown, `/e/${'A'.repeat(44)}`, `/e/${'A'.repeat(42)}!`, '/e/..%2F..%2Fadmin', `/e/${encodeURIComponent("' OR 1=1 --")}`]) {
        const attempts = [
          ['GET info', await holder(t).open(path)],
          ['GET form', await holder(t).form(path)],
          ['POST form', await holder(t).save(path, { maps_link: mapsPlace(1).url })],
        ];
        for (const [what, res] of attempts) {
          assert.equal(res.status, 404, `${what} ${path}`);
          assert.match(res.text, /Link Edit Tidak Valid/, `${what} ${path}`);
          assert.doesNotMatch(res.text, /BR-000001|Warung Sate|postgres|SELECT|stack/i, `${what} ${path}`);
          assert.equal(res.headers['set-cookie'], undefined);
        }
      }
      assert.equal((await holder(t).open('/e')).status, 404);
      assert.equal((await holder(t).open(`/e/${'A'.repeat(43)}/lagi`)).status, 404);
      assert.equal((await holder(t).open(`/e/${'A'.repeat(43)}/edit/lagi`)).status, 404);
      assert.equal((await barcodeRow()).target_url, null);
    });

    it('a barcode name is escaped on both pages, and the ?saved= flag cannot be used to inject text', async () => {
      const link = await pendingBarcode({ name: '<img src=x onerror=alert(1)>' });
      const res = await holder(t).open(`${link}?saved=%3Cscript%3Ealert(1)%3C/script%3E`);
      assert.equal(res.status, 200);
      assert.ok(!res.text.includes('<img src=x'), 'name is HTML-escaped');
      assert.match(res.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
      assert.ok(!res.text.includes('alert(1)</script>'));
      assert.doesNotMatch(res.text, /Maps tersimpan|Tidak ada yang berubah/, 'unknown values show nothing');
      for (const evil of ['__proto__', 'constructor', 'toString', '1&saved=1', '1,0']) {
        assert.equal((await holder(t).open(`${link}?saved=${encodeURIComponent(evil)}`)).status, 200);
      }
      const form = await holder(t).form(link);
      assert.ok(!form.text.includes('<img src=x'));
      assert.match(form.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    });

    it('the info page confirms a save with a notice that comes only from the two known ?saved= values', async () => {
      const link = await pendingBarcode();
      assert.doesNotMatch((await holder(t).open(link)).text, /Maps tersimpan|Tidak ada yang berubah/, 'no notice on a plain visit');
      assert.match((await holder(t).open(`${link}?saved=1`)).text, /Maps tersimpan/);
      assert.match((await holder(t).open(`${link}?saved=1`)).text, /Simpan alamat halaman ini/, 'after activation the QR no longer leads here: keep the address to change the place later');
      assert.match((await holder(t).open(`${link}?saved=0`)).text, /Tidak ada yang berubah/);
      assert.doesNotMatch((await t.request().get(`${link}/edit?saved=1`)).text, /Maps tersimpan/, 'the form page never shows it');
    });

    it('robots.txt keeps crawlers away from edit links', async () => {
      assert.match((await t.request().get('/robots.txt')).text, /Disallow: \/e\//);
    });
  });

  describe('saving a Google Maps link', () => {
    it('fills in the barcode at once: Place ID stored, review page as destination, the printed QR redirects, the history says who and from where', async () => {
      const place = mapsPlace(1);
      const link = await pendingBarcode();
      assert.equal((await scan(t, 'BR-000001')).status, 200, 'still waiting');

      const res = await holder(t).save(link, { maps_link: place.url });
      assert.equal(res.status, 303, 'POST -> redirect -> GET: reloading the page does not re-submit');
      assert.equal(res.headers.location, `${link}?saved=1`, 'after saving, the person lands on the info page');
      assert.equal(res.headers['set-cookie'], undefined);

      const done = await holder(t).open(res.headers.location);
      assert.match(done.text, /Maps tersimpan/);
      assert.match(done.text, /Maps terhubung/);
      assert.match(done.text, /Aktif/, 'the badge follows the new state');

      const row = await barcodeRow();
      assert.equal(row.target_type, 'maps_review');
      assert.equal(row.maps_place_id, place.placeId, 'the Place ID is the primary data');
      assert.equal(row.target_url, place.reviewUrl, 'the review page is what scanners are sent to');
      assert.equal(row.maps_source_url, place.url, 'the link the person pasted is kept as well');
      assert.equal(row.target_url, `https://search.google.com/local/writereview?placeid=${place.placeId}`);

      const ok = await scan(t, 'BR-000001');
      assert.equal(ok.status, 302);
      assert.equal(ok.headers.location, place.reviewUrl);

      const history = await t.db.rows('SELECT old_url, new_url, changed_by, changed_via, host(changed_ip) AS ip FROM barcode_history');
      assert.deepEqual(history.map((h) => ({ ...h })), [{ old_url: null, new_url: place.reviewUrl, changed_by: null, changed_via: 'edit_link', ip: '127.0.0.1' }]);
      assert.equal((await t.db.one('SELECT count(*)::int AS n FROM user_sessions')).n, 0);
    });

    it('expands a short link on the server, reading only the header of the redirect, and stores the same Place ID', async () => {
      const place = mapsPlace(4);
      const google = fakeGoogle({ [place.shortUrl]: place.url });
      const t2 = await startApp({}, { maps: google.maps });
      try {
        const link = await pendingBarcode({}, t2);
        const res = await holder(t2).save(link, { maps_link: place.shortUrl });
        assert.equal(res.status, 303, res.text);

        assert.equal(google.calls.length, 1, 'one request to Google: the expanded URL already carries the location id');
        assert.equal(google.calls[0].url, place.shortUrl);
        assert.equal(google.calls[0].options.method, 'GET');
        assert.equal(google.calls[0].options.redirect, 'manual', 'redirects are never followed automatically');

        const row = await barcodeRow(t2);
        assert.equal(row.maps_place_id, place.placeId);
        assert.equal(row.target_url, place.reviewUrl);
        assert.equal(row.maps_source_url, place.shortUrl, 'the original (short) link is what is remembered');
      } finally {
        await t2.close();
      }
    });

    it('a link with or without the scheme, in any letter case, with surrounding spaces, all work', async () => {
      const place = mapsPlace(7);
      const withoutScheme = place.url.replace('https://', '');
      const link = await pendingBarcode();
      for (const typed of [`  ${place.url}  `, withoutScheme, place.url.replace('www.google.com', 'WWW.GOOGLE.COM'), place.url.replace('https://', 'http://')]) {
        const res = await holder(t).save(link, { maps_link: typed });
        assert.equal(res.status, 303, typed);
      }
      assert.equal((await barcodeRow()).maps_place_id, place.placeId);
      assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_history')).n, 1, 'the same place four times is one change');
    });

    it('saving the same place again, even through another link to it, changes nothing and writes no history', async () => {
      const place = mapsPlace(5);
      const google = fakeGoogle({ [place.shortUrl]: place.url });
      const t2 = await startApp({}, { maps: google.maps });
      try {
        const link = await pendingBarcode({}, t2);
        assert.equal((await holder(t2).save(link, { maps_link: place.url })).headers.location, `${link}?saved=1`);
        const again = await holder(t2).save(link, { maps_link: place.shortUrl });
        assert.equal(again.status, 303);
        assert.equal(again.headers.location, `${link}?saved=0`);
        assert.match((await holder(t2).open(again.headers.location)).text, /Tidak ada yang berubah/);
        assert.equal((await t2.db.one('SELECT count(*)::int AS n FROM barcode_history')).n, 1);
      } finally {
        await t2.close();
      }
    });

    it('a different place replaces the first one, and the history keeps both', async () => {
      const [first, second] = [mapsPlace(1), mapsPlace(2)];
      const link = await pendingBarcode();
      await holder(t).save(link, { maps_link: first.url });
      await holder(t).save(link, { maps_link: second.url });
      assert.equal((await scan(t, 'BR-000001')).headers.location, second.reviewUrl);
      const history = await t.db.rows('SELECT old_url, new_url FROM barcode_history ORDER BY id');
      assert.deepEqual(history.map((h) => [h.old_url, h.new_url]), [[null, first.reviewUrl], [first.reviewUrl, second.reviewUrl]]);
    });

    it('replaces an ordinary destination an admin had set, and the history says what it replaced', async () => {
      const place = mapsPlace(1);
      const link = await pendingBarcode({ targetUrl: 'https://contoh.com/situs-lama' });
      assert.equal((await holder(t).save(link, { maps_link: place.url })).status, 303);
      const row = await barcodeRow();
      assert.deepEqual([row.target_type, row.target_url, row.maps_place_id], ['maps_review', place.reviewUrl, place.placeId]);
      const history = await t.db.rows('SELECT old_url, new_url FROM barcode_history');
      assert.deepEqual(history.map((h) => [h.old_url, h.new_url]), [['https://contoh.com/situs-lama', place.reviewUrl]]);
    });

    it('works for inactive and expired barcodes too: the person cannot switch them on', async () => {
      const place = mapsPlace(1);
      const inactive = await pendingBarcode({ status: 'inactive', targetUrl: 'https://contoh.com/a' });
      assert.equal((await holder(t).save(inactive, { maps_link: place.url })).status, 303);
      assert.equal((await scan(t, 'BR-000001')).status, 403, 'still inactive');
      await t.reset();
      const expired = await pendingBarcode({ expiredLocal: '2001-01-01 00:00:00', targetUrl: 'https://contoh.com/a' });
      assert.equal((await holder(t).save(expired, { maps_link: place.url })).status, 303);
      assert.equal((await scan(t, 'BR-000001')).status, 410);
    });

    it('with the redirect cache on, a change takes effect immediately', async () => {
      const place = mapsPlace(1);
      const cached = await startApp({ REDIRECT_CACHE_TTL_MS: '60000' });
      try {
        const link = await pendingBarcode({}, cached);
        assert.equal((await scan(cached, 'BR-000001')).status, 200, 'pending page, now cached');
        assert.equal(cached.ctx.cache.size, 1);
        await holder(cached).save(link, { maps_link: place.url });
        const res = await scan(cached, 'BR-000001');
        assert.equal(res.status, 302);
        assert.equal(res.headers.location, place.reviewUrl);
      } finally {
        await cached.close();
      }
    });

    it('the QR printed BEFORE any Maps link existed works the moment it is saved, byte for byte unchanged', async () => {
      const place = mapsPlace(1);
      await makeUser(t.ctx, { username: 'admin' });
      const admin = await loginAgent(t);
      const code = createdCode(await postForm(admin, '/admin/barcodes', { name: 'Stiker Meja 1' }, { tokenPage: '/admin/barcodes/new' }));
      const link = `/e/${await editTokenOf(t.ctx, code)}`;

      const printed = await getBuffer(admin, `/admin/barcodes/${code}/qr.png?download=1`);
      const address = decode(printed);
      assert.equal(address, `https://barcode.test/b/${code}`, 'the QR only ever holds the system address');
      const before = await t.request().get(new URL(address).pathname);
      assert.equal(before.status, 302, 'scanned before anything is entered, the card leads to its activation page');
      assert.equal(before.headers.location, link);

      await holder(t).save(link, { maps_link: place.url });
      const after = await t.request().get(new URL(address).pathname);
      assert.equal(after.status, 302);
      assert.equal(after.headers.location, place.reviewUrl, 'the same QR now leads to the review page');
      assert.ok((await getBuffer(admin, `/admin/barcodes/${code}/qr.png?download=1`)).equals(printed), 'the printed image is still exactly the current QR');
    });

    it('shows up in the admin screens as "Link edit", with the Place ID and the pasted link on the detail page', async () => {
      const place = mapsPlace(1);
      await makeUser(t.ctx, { username: 'admin' });
      const admin = await loginAgent(t);
      const link = await pendingBarcode();
      await holder(t).save(link, { maps_link: place.url });

      for (const page of ['/admin/barcodes/BR-000001', '/admin/history', '/admin']) {
        const res = await admin.get(page);
        assert.match(res.text, /Link edit/, page);
        assert.match(res.text, /127\.0\.0\.1/, `${page} shows where the change came from`);
      }
      const detail = (await admin.get('/admin/barcodes/BR-000001')).text;
      assert.match(detail, /Ulasan Google Maps/);
      assert.ok(detail.includes(place.placeId), 'Place ID');
      assert.ok(detail.includes(place.url), 'the pasted Maps link');
      assert.ok(detail.includes(place.reviewUrl), 'the review page');
    });

    it('concurrent saves through one link never corrupt the history chain', async () => {
      const link = await pendingBarcode();
      const places = Array.from({ length: 8 }, (_, i) => mapsPlace(i + 1));
      const results = await Promise.all(places.map((p) => holder(t).save(link, { maps_link: p.url })));
      assert.ok(results.every((r) => r.status === 303));

      const history = await t.db.rows('SELECT old_url, new_url FROM barcode_history ORDER BY id');
      assert.equal(history.length, 8, 'each distinct change is recorded once');
      assert.equal(history[0].old_url, null);
      for (let i = 1; i < history.length; i += 1) assert.equal(history[i].old_url, history[i - 1].new_url, `row ${i} continues where row ${i - 1} ended`);
      const row = await barcodeRow();
      assert.equal(row.target_url, history.at(-1).new_url);
      assert.equal(row.maps_place_id, new URL(row.target_url).searchParams.get('placeid'), 'Place ID and address always belong together');
    });
  });

  describe('refusing what is not a Google Maps link', () => {
    it('refuses every wrong kind of link with a message, keeps what was typed, and changes nothing', async () => {
      const link = await pendingBarcode();
      const cases = [
        ['', /wajib diisi/],
        ['   ', /wajib diisi/],
        ['https://example.com/maps', /dari Google Maps/],
        ['https://www.google.com/search?q=toko', /dari Google Maps/],
        ['https://google.com.evil.test/maps/place/x', /dari Google Maps/],
        ['https://maps.app.goo.gl.evil.test/x', /dari Google Maps/],
        ['https://goo.gl/abc', /dari Google Maps/],
        ['javascript:alert(1)', /https/],
        ['ftp://maps.app.goo.gl/x', /https/],
        ['https://user:pass@maps.app.goo.gl/x', /username atau password/],
        ['https://maps.app.goo.gl/a b', /spasi/],
        [`https://www.google.com/maps/${'a'.repeat(2100)}`, /terlalu panjang/],
        ['https://www.google.com/maps/place/x/@1,2,17z', /ID lokasi tidak ditemukan/],
        [mapsPlace(1).shortUrl, /tidak bisa dibuka saat ini/], // the offline resolver cannot reach Google
      ];
      for (const [typed, message] of cases) {
        const res = await holder(t).save(link, { maps_link: typed });
        assert.equal(res.status, 422, typed.slice(0, 60));
        assert.match(res.text, message, typed.slice(0, 60));
        assert.match(res.text, /Maps belum bisa disimpan/);
        assert.ok(res.text.includes(`action="${link}/edit"`), 'the person stays on the form page, which can be submitted again');
        assert.ok(res.text.includes(`href="${link}"`), 'with a way back to the info page');
      }
      const kept = await holder(t).save(link, { maps_link: 'https://example.com/tetap-ada' });
      assert.match(kept.text, /value="https:\/\/example\.com\/tetap-ada"/, 'what was typed stays in the field');
      const row = await barcodeRow();
      assert.equal(row.target_url, null);
      assert.equal(row.maps_place_id, null);
      assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_history')).n, 0);
    });

    it('the public link can no longer point the barcode at an arbitrary website or address', async () => {
      const link = await pendingBarcode();
      for (const fields of [
        { target_type: 'url', target_value: 'https://contoh.com/situs-jahat' },
        { target_type: 'whatsapp', target_value: '081234567890' },
        { target_value: 'https://contoh.com/situs-jahat' },
        { maps_link: '', target_value: 'https://contoh.com/situs-jahat' },
        { maps_link: 'https://contoh.com/situs-jahat', target_type: 'maps_review' },
      ]) {
        const res = await holder(t).save(link, fields);
        assert.equal(res.status, 422, JSON.stringify(fields));
      }
      assert.equal((await barcodeRow()).target_url, null);
    });

    it('a filled Maps destination cannot be blanked through the link', async () => {
      const place = mapsPlace(1);
      const link = await mapsBarcode(place);
      assert.equal((await holder(t).save(link, { maps_link: '' })).status, 422);
      assert.equal((await barcodeRow()).target_url, place.reviewUrl);
    });

    it('can touch the destination and NOTHING else, whatever else is sent along', async () => {
      const place = mapsPlace(1);
      const link = await pendingBarcode({ description: 'catatan admin' });
      const before = await barcodeRow();
      const res = await holder(t).save(link, {
        maps_link: place.url,
        name: 'DIRETAS',
        description: 'DIRETAS',
        status: 'inactive',
        expired_at: '2001-01-01T00:00',
        edit_token: 'A'.repeat(43),
        scan_count: '999',
        code: 'BR-999999',
        id: '77',
        created_by: '1',
        maps_place_id: 'ChIJ_diretas_diretas_diretas',
      });
      assert.equal(res.status, 303);
      const after = await barcodeRow();
      const { target_type: type, target_url: url, maps_place_id: placeId, maps_source_url: source, ...unchanged } = after;
      const { target_type: _t, target_url: _u, maps_place_id: _p, maps_source_url: _s, ...untouched } = before;
      assert.deepEqual([type, url, placeId, source], ['maps_review', place.reviewUrl, place.placeId, place.url]);
      assert.deepEqual({ ...unchanged }, { ...untouched });
    });

    it('refuses oversized submissions before they reach the database', async () => {
      const link = await pendingBarcode();
      const res = await holder(t).save(link, { maps_link: `https://www.google.com/maps/${'a'.repeat(40000)}` });
      assert.equal(res.status, 413);
      assert.equal((await barcodeRow()).target_url, null);
    });
  });

  describe('talking to Google (short links) safely', () => {
    it('a dead link never costs a request to Google', async () => {
      const place = mapsPlace(1);
      const google = fakeGoogle({ [place.shortUrl]: place.url });
      const t2 = await startApp({}, { maps: google.maps });
      try {
        await pendingBarcode({}, t2);
        const res = await holder(t2).save(`/e/${'A'.repeat(43)}`, { maps_link: place.shortUrl });
        assert.equal(res.status, 404);
        assert.equal(google.calls.length, 0);
      } finally {
        await t2.close();
      }
    });

    it('a redirect that leaves Google is refused, and nothing but the short link was requested', async () => {
      const short = mapsPlace(1).shortUrl;
      for (const target of ['https://evil.test/x', 'http://169.254.169.254/latest/meta-data/', 'https://google.com.evil.test/maps/place/x']) {
        const google = fakeGoogle({ [short]: target });
        const t2 = await startApp({}, { maps: google.maps });
        try {
          const link = await pendingBarcode({}, t2);
          const res = await holder(t2).save(link, { maps_link: short });
          assert.equal(res.status, 422, target);
          assert.match(res.text, /tidak mengarah ke lokasi/, target);
          assert.deepEqual(google.calls.map((c) => c.url), [short], `only the short link was requested for ${target}`);
          assert.equal((await barcodeRow(t2)).target_url, null);
        } finally {
          await t2.close();
        }
      }
    });

    it('a network failure is a friendly message, not an error page, and nothing is saved', async () => {
      const short = mapsPlace(1).shortUrl;
      const google = fakeGoogle({ [short]: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      const t2 = await startApp({}, { maps: google.maps });
      try {
        const link = await pendingBarcode({}, t2);
        const res = await holder(t2).save(link, { maps_link: short });
        assert.equal(res.status, 422);
        assert.match(res.text, /tidak bisa dibuka saat ini/);
        assert.equal((await barcodeRow(t2)).target_url, null);
      } finally {
        await t2.close();
      }
    });

    it('asks Google while NO database lock is held: a slow answer cannot stall anything else on that barcode', async () => {
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
        const link = await pendingBarcode({}, t2);
        const saving = holder(t2).save(link, { maps_link: place.shortUrl }).then((res) => res); // in flight, waiting for "Google"
        await askedPromise;
        // What every scan does. If the save held the row lock while waiting for Google, this would block.
        const outcome = await Promise.race([
          t2.db.query("UPDATE barcodes SET scan_count = scan_count + 1 WHERE code = 'BR-000001'").then(() => 'free'),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), 1500)),
        ]);
        assert.equal(outcome, 'free', 'the barcode row must stay free while Google is being asked');
        release();
        assert.equal((await saving).status, 303);
        assert.equal((await barcodeRow(t2)).maps_place_id, place.placeId);
      } finally {
        release?.();
        await t2.close();
      }
    });
  });
});

describe('public edit link: rate limits, IPs and logs', () => {
  const place = mapsPlace(1);

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

  it('limits how often ONE link can save, so a leaked link cannot flood the history or Google; other links are unaffected', async () => {
    const t = await startApp({ EDIT_LINK_SAVE_RATE_LIMIT_MAX: '3' });
    try {
      await insertBarcodes(t.ctx, [{ targetUrl: null }, { targetUrl: null }]);
      const a = `/e/${await editTokenOf(t.ctx, 'BR-000001')}`;
      const b = `/e/${await editTokenOf(t.ctx, 'BR-000002')}`;
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await holder(t).save(a, { maps_link: mapsPlace(i + 1).url })).status);
      assert.deepEqual(statuses, [303, 303, 303, 429, 429]);
      assert.equal((await holder(t).save(b, { maps_link: mapsPlace(9).url })).status, 303);
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

  it('stores the caller IP behind a trusted proxy, and only its network part when IP_ANONYMIZE is on', async () => {
    const proxied = await startApp({ TRUST_PROXY: '1' });
    try {
      await insertBarcodes(proxied.ctx, [{ targetUrl: null }]);
      const link = `/e/${await editTokenOf(proxied.ctx, 'BR-000001')}`;
      await proxied.request().post(`${link}/edit`).set('X-Forwarded-For', '203.0.113.77').type('form').send({ maps_link: place.url });
      assert.equal((await proxied.db.one('SELECT host(changed_ip) AS ip FROM barcode_history')).ip, '203.0.113.77');
    } finally {
      await proxied.close();
    }
    const anon = await startApp({ TRUST_PROXY: '1', IP_ANONYMIZE: 'true' });
    try {
      await insertBarcodes(anon.ctx, [{ targetUrl: null }]);
      const link = `/e/${await editTokenOf(anon.ctx, 'BR-000001')}`;
      await anon.request().post(`${link}/edit`).set('X-Forwarded-For', '203.0.113.77').type('form').send({ maps_link: place.url });
      assert.equal((await anon.db.one('SELECT host(changed_ip) AS ip FROM barcode_history')).ip, '203.0.113.0');
    } finally {
      await anon.close();
    }
  });

  it('never writes the secret link into the logs (access log lines carry /e/[redacted])', async () => {
    const t = await startApp();
    const lines = [];
    const logger = pino({ level: 'info' }, { write: (line) => lines.push(line) });
    const logged = createContext(t.config, { logger, maps: offlineMaps() });
    try {
      await insertBarcodes(t.ctx, [{ targetUrl: null }]);
      const token = await editTokenOf(t.ctx, 'BR-000001');
      const guess = 'G'.repeat(43);
      const api = supertest(createApp(logged));

      await api.get(`/e/${token}`);
      await api.get(`/e/${token}/edit`);
      await api.post(`/e/${token}/edit`).type('form').send({ maps_link: place.url });
      await api.get(`/e/${token}?saved=1`);
      await api.post(`/e/${token}/edit`).type('form').send({ maps_link: 'https://example.com/bukan-maps' });
      await api.get(`/e/${guess}`);
      await api.get(`/e/${guess}/edit`);
      await api.get('/e/tidak-valid');

      const log = lines.join('\n');
      assert.ok(log.includes('/e/[redacted]'), 'requests are logged, with the secret masked');
      assert.ok(log.includes('/e/[redacted]/edit'), 'the form page is covered too: the secret is the first segment');
      assert.ok(log.includes('google maps set through the edit link'), 'the change itself is logged (by code)');
      assert.ok(!log.includes(token), 'the real link is nowhere in the log');
      assert.ok(!log.includes(guess), 'not even a guessed one');
      assert.ok(!log.includes('tidak-valid'));
      assert.ok(!log.includes(place.url) && !log.includes(place.placeId), 'the pasted Maps link and the Place ID are not logged either');
    } finally {
      await logged.close();
      await t.close();
    }
  });
});
