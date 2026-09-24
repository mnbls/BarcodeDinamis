import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { editTokenOf, insertBarcodes, loginAgent, makeUser, mapsPlace, startApp } from '../helpers/app.js';

const PRINT_CSS = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'public', 'css', 'print.css'), 'utf8');

describe('print page: the review card', () => {
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

  /** BR-000001 leads to a Google review page, BR-000002 still waits for its destination, BR-000003 is an ordinary link. */
  const seed = async () => {
    const place = mapsPlace(1);
    await insertBarcodes(t.ctx, [
      { name: 'Warung Sate Pak Slamet', targetType: 'maps_review', targetUrl: place.reviewUrl, mapsPlaceId: place.placeId, mapsSourceUrl: place.url },
      { name: 'Stiker Meja 1', targetUrl: null },
      { name: 'Katalog Produk', targetUrl: 'https://contoh.com/katalog' },
    ]);
  };
  const page = async (code, query = '') => {
    const res = await admin.get(`/admin/barcodes/${code}/print${query}`);
    assert.equal(res.status, 200, `${code}${query}`);
    return res.text;
  };

  it('offers the card for a Google review barcode and for one still waiting for its destination, never for an ordinary link', async () => {
    await seed();
    for (const code of ['BR-000001', 'BR-000002']) {
      const html = await page(code);
      assert.match(html, /name="layout" value="card"/, `${code}: layout choice`);
      assert.match(html, /class="pcards"/, `${code}: the card is on the page`);
      assert.match(html, /Riview Yuk/, `${code}: brand name from BRAND_NAME`);
      assert.match(html, /Bagikan pengalaman Anda/);
      assert.match(html, /Pindai untuk menulis ulasan di Google/);
      assert.ok(html.split(`/admin/barcodes/${code}/qr.svg`).length - 1 >= 2, `${code}: label and card use the same QR file`);
    }
    for (const query of ['', '?layout=card']) {
      const html = await page('BR-000003', query);
      assert.doesNotMatch(html, /name="layout"/, `an ordinary link has no layout choice ${query}`);
      assert.doesNotMatch(html, /pcards|pcard__/, `an ordinary link has no card ${query}`);
      assert.match(html, /data-label/, 'the plain label is still there');
    }
  });

  it('opens the label by default and the card for ?layout=card; anything else falls back to the label', async () => {
    await seed();
    assert.match(await page('BR-000001'), /name="layout" value="label" checked/);
    assert.match(await page('BR-000001', '?layout=card'), /name="layout" value="card" checked/);
    assert.doesNotMatch(await page('BR-000001', '?layout=card'), /name="layout" value="label" checked/);
    for (const query of ['?layout=bogus', '?layout=card&layout=x', '?layout[]=card', '?layout=CARD']) {
      const html = await page('BR-000001', query);
      assert.match(html, /name="layout" value="label" checked/, query);
      assert.doesNotMatch(html, /name="layout" value="card" checked/, query);
    }
    // the size and colour choices start on the defaults: standard card, dark
    const html = await page('BR-000001', '?layout=card');
    assert.match(html, /name="card-size" value="standard" checked/);
    assert.match(html, /name="card-theme" value="dark" checked/);
  });

  it('front: brand, five stars, headline, QR, name and code. Back: three steps and the address to type when scanning fails', async () => {
    await seed();
    const html = await page('BR-000001', '?layout=card');
    const front = html.slice(html.indexOf('pcard--front'), html.indexOf('pcard--back'));
    const back = html.slice(html.indexOf('pcard--back'));

    assert.match(front, /pcard__brand-name">Riview Yuk</);
    assert.equal(front.match(/<svg class="icon"/g).length, 6, 'brand mark + five stars');
    assert.match(front, /pcard__qr"><img src="\/admin\/barcodes\/BR-000001\/qr\.svg"/);
    assert.match(front, /pcard__name">Warung Sate Pak Slamet</);
    assert.match(front, /pcard__code">BR-000001</);

    assert.match(back, /Tulis ulasan dalam tiga langkah/);
    for (const step of ['Buka kamera ponsel', 'Arahkan ke kode QR di sisi depan', 'Ketuk tautan, lalu tulis ulasan Anda']) assert.ok(back.includes(step), step);
    assert.match(back, /Atau buka <b>barcode\.test\/b\/BR-000001<\/b>/, 'the same address the QR carries, without the protocol');
    assert.doesNotMatch(back, /pcard__qr/, 'one QR per card: on the front');
  });

  it('never shows the secret edit link, and escapes hostile text', async () => {
    await seed();
    const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    await insertBarcodes(t.ctx, [{ name: payload, targetUrl: null }]);
    for (const code of ['BR-000001', 'BR-000002', 'BR-000004']) {
      const html = await page(code, '?layout=card');
      assert.ok(!html.includes(await editTokenOf(t.ctx, code)), `${code}: the token is not printed`);
      assert.doesNotMatch(html, /\/e\/[A-Za-z0-9_-]{20,}/, `${code}: no edit address at all`);
    }
    const hostile = await page('BR-000004', '?layout=card');
    assert.ok(!hostile.includes('<script>alert("xss")'), 'raw script tag must not appear');
    assert.ok(!hostile.includes('<img src=x'), 'raw img tag must not appear');
    assert.match(hostile, /pcard__name">&lt;script&gt;/);
  });

  it('shows "Cetak kartu" on the detail page and in the list only where a card exists', async () => {
    await seed();
    for (const code of ['BR-000001', 'BR-000002']) {
      const detail = await admin.get(`/admin/barcodes/${code}`);
      assert.match(detail.text, new RegExp(`/admin/barcodes/${code}/print\\?layout=card`), code);
      assert.match(detail.text, /Cetak kartu/);
    }
    const plain = await admin.get('/admin/barcodes/BR-000003');
    assert.doesNotMatch(plain.text, /layout=card|Cetak kartu/, 'an ordinary link has no card button');

    const list = (await admin.get('/admin/barcodes')).text;
    assert.match(list, /BR-000001\/print\?layout=card/);
    assert.match(list, /BR-000002\/print\?layout=card/);
    assert.doesNotMatch(list, /BR-000003\/print\?layout=card/);
  });

  it('keeps the label as it was: plain QR, name, code, address and the three sizes', async () => {
    await seed();
    const html = await page('BR-000003');
    assert.match(html, /data-print/);
    assert.match(html, /class="label__name">Katalog Produk</);
    assert.match(html, /https:\/\/barcode\.test\/b\/BR-000003/);
    for (const size of ['3.5cm', '6cm', '9cm']) assert.match(html, new RegExp(`name="size" value="${size}"`));
  });

  it('the stylesheet keeps what a printout depends on: forced backgrounds, real page sizes, one card per page', () => {
    const rule = (re, what) => assert.match(PRINT_CSS, re, what);
    rule(/print-color-adjust:\s*exact/, 'a dark card must keep its background when "Background graphics" is off');
    rule(/@page pcard-standard\s*\{\s*size:\s*85\.6mm 54mm;\s*margin:\s*0;?\s*\}/, 'standard card = ID-1 size, no margin');
    rule(/@page pcard-large\s*\{\s*size:\s*145\.5mm 91\.8mm;\s*margin:\s*0;?\s*\}/, 'large card keeps the same proportions');
    rule(/\.pcards\s*\{[^}]*page:\s*pcard-standard/, 'the card uses the named page');
    rule(/break-after:\s*page/, 'front and back are separate pages');
    rule(/--card-w:\s*85\.6mm;\s*--card-h:\s*54mm/, 'real size in print');
    assert.match(PRINT_CSS, /--card-h:\s*calc\(var\(--card-w\) \* 54 \/ 85\.6\)/, 'the preview keeps the card proportions');
  });
});
