import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { getBuffer, loginAgent, makeUser, postForm, startApp } from '../helpers/app.js';

const decode = (buffer) => {
  const png = PNG.sync.read(buffer);
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
};

/**
 * THE core promise of the product: a QR that was printed once keeps working after the destination is
 * changed. These tests behave like a person with a phone: they decode the ORIGINAL printed image and
 * open whatever address is inside it.
 */
describe('a printed QR code stays valid after the destination changes', () => {
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

  const editTo = (code, url, extra = {}) =>
    postForm(admin, `/admin/barcodes/${code}`, { name: 'Produk A', target_type: 'url', target_value: url, status: 'active', ...extra }, { tokenPage: `/admin/barcodes/${code}/edit` });

  /** "Scan" a printed image: decode it, then request the decoded address like a phone would. */
  const scanPrinted = async (pngBuffer) => {
    const address = decode(pngBuffer);
    assert.ok(address, 'the printed QR must be decodable');
    const url = new URL(address);
    assert.equal(url.origin, 'https://barcode.test', 'QR points at the system domain');
    const res = await t.request().get(url.pathname);
    await t.ctx.recorder.idle();
    return { address, res };
  };

  it('scenario from the brief: BR-000001 A -> B, printed QR unchanged, redirect follows the database', async () => {
    const created = await postForm(admin, '/admin/barcodes', { name: 'Produk A', target_type: 'url', target_value: 'https://contoh.com/a', status: 'active' }, { tokenPage: '/admin/barcodes/new' });
    assert.equal(created.headers.location, '/admin/barcodes/BR-000001');

    // 1. the person downloads and prints the QR
    const printedPng = await getBuffer(admin, '/admin/barcodes/BR-000001/qr.png?download=1');
    const printedSvg = (await getBuffer(admin, '/admin/barcodes/BR-000001/qr.svg?download=1')).toString();

    // 2. scanning it leads to A
    let { address, res } = await scanPrinted(printedPng);
    assert.equal(address, 'https://barcode.test/b/BR-000001');
    assert.equal(res.headers.location, 'https://contoh.com/a');
    assert.ok(!address.includes('contoh.com'), 'the destination is NOT inside the QR');

    // 3. the admin changes the destination
    assert.equal((await editTo('BR-000001', 'https://contoh.com/b')).status, 302);

    // 4. the SAME printed image now leads to B
    ({ address, res } = await scanPrinted(printedPng));
    assert.equal(address, 'https://barcode.test/b/BR-000001', 'the encoded address never changed');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, 'https://contoh.com/b');

    // 5. downloading the QR again yields byte-identical files: nothing was regenerated differently
    assert.ok((await getBuffer(admin, '/admin/barcodes/BR-000001/qr.png?download=1')).equals(printedPng), 'PNG identical');
    assert.equal((await getBuffer(admin, '/admin/barcodes/BR-000001/qr.svg?download=1')).toString(), printedSvg, 'SVG identical');

    // 6. the change is documented
    const history = await t.db.rows('SELECT old_url, new_url FROM barcode_history');
    assert.deepEqual(history.map((h) => ({ ...h })), [{ old_url: 'https://contoh.com/a', new_url: 'https://contoh.com/b' }]);
  });

  it('survives 25 consecutive destination changes, across types, deactivation and reactivation', async () => {
    await postForm(admin, '/admin/barcodes', { name: 'Produk A', target_type: 'url', target_value: 'https://contoh.com/0', status: 'active' }, { tokenPage: '/admin/barcodes/new' });
    const printedPng = await getBuffer(admin, '/admin/barcodes/BR-000001/qr.png');

    for (let i = 1; i <= 25; i += 1) {
      await editTo('BR-000001', `https://contoh.com/versi-${i}`);
      const { res } = await scanPrinted(printedPng);
      assert.equal(res.headers.location, `https://contoh.com/versi-${i}`, `after change #${i}`);
    }

    // switch to WhatsApp: same printed image, different kind of destination
    await editTo('BR-000001', '081234567890', { target_type: 'whatsapp', target_extra: 'Halo' });
    assert.equal((await scanPrinted(printedPng)).res.headers.location, 'https://wa.me/6281234567890?text=Halo');

    // deactivate: the printed QR shows the info page; reactivate: it works again with the LATEST destination
    await postForm(admin, '/admin/barcodes/BR-000001/status', { status: 'inactive' }, { tokenPage: '/admin' });
    const blocked = (await scanPrinted(printedPng)).res;
    assert.equal(blocked.status, 403);
    assert.match(blocked.text, /Barcode Tidak Aktif/);
    await postForm(admin, '/admin/barcodes/BR-000001/status', { status: 'active' }, { tokenPage: '/admin' });
    assert.equal((await scanPrinted(printedPng)).res.headers.location, 'https://wa.me/6281234567890?text=Halo');

    const changes = await t.db.one('SELECT count(*)::int AS n FROM barcode_history');
    assert.equal(changes.n, 26, '25 URL edits + the switch to WhatsApp');
    const scans = await t.db.one('SELECT scan_count FROM barcodes');
    assert.equal(scans.scan_count, 25 + 1 + 1, 'every successful scan of the same barcode is counted on the same row');
  });

  it('an expiry date can be added, extended and removed without touching the printed QR', async () => {
    await postForm(admin, '/admin/barcodes', { name: 'Produk A', target_type: 'url', target_value: 'https://contoh.com/a', status: 'active' }, { tokenPage: '/admin/barcodes/new' });
    const printedPng = await getBuffer(admin, '/admin/barcodes/BR-000001/qr.png');
    await t.db.query("UPDATE barcodes SET expired_at = now() - interval '1 minute'");
    assert.equal((await scanPrinted(printedPng)).res.status, 410);
    await editTo('BR-000001', 'https://contoh.com/a', { expired_at: '2099-01-01T00:00' });
    assert.equal((await scanPrinted(printedPng)).res.status, 302);
    await editTo('BR-000001', 'https://contoh.com/a', { expired_at: '' });
    assert.equal((await t.db.one('SELECT expired_at FROM barcodes')).expired_at, null);
    assert.equal((await scanPrinted(printedPng)).res.status, 302);
  });

  it('every barcode has its own independent QR (no code shared between barcodes)', async () => {
    for (const name of ['A', 'B', 'C']) await postForm(admin, '/admin/barcodes', { name, target_type: 'url', target_value: `https://contoh.com/${name}`, status: 'active' }, { tokenPage: '/admin/barcodes/new' });
    const decoded = [];
    for (const code of ['BR-000001', 'BR-000002', 'BR-000003']) decoded.push(decode(await getBuffer(admin, `/admin/barcodes/${code}/qr.png`)));
    assert.deepEqual(decoded, ['https://barcode.test/b/BR-000001', 'https://barcode.test/b/BR-000002', 'https://barcode.test/b/BR-000003']);
  });
});
