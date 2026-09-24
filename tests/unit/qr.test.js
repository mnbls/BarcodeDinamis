import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { createQrService } from '../../src/lib/qr.js';
import { testConfig } from '../helpers/app.js';

/** Decodes a PNG buffer with an independent QR reader. */
function decodePng(buffer) {
  const png = PNG.sync.read(buffer);
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return { text: result?.data ?? null, width: png.width, height: png.height };
}

describe('QR generation', () => {
  const config = testConfig();
  const qr = createQrService(config);

  it('encodes the dynamic redirect URL, not the destination', async () => {
    const decoded = decodePng(await qr.png('BR-000001'));
    assert.equal(decoded.text, 'https://barcode.test/b/BR-000001');
    assert.ok(!decoded.text.includes('example.com'));
  });

  it('is scannable at several sizes and stays square', async () => {
    for (const size of [256, 512, 1024, 2048]) {
      const { text, width, height } = decodePng(await qr.png('BR-123456', { size }));
      assert.equal(text, 'https://barcode.test/b/BR-123456', `size ${size}`);
      assert.equal(width, height);
      assert.ok(width <= size && width > size * 0.8, `width ${width} for requested ${size}`);
    }
  });

  it('clamps absurd sizes instead of exhausting memory', async () => {
    const { width } = decodePng(await qr.png('BR-000001', { size: 10_000_000 }));
    assert.ok(width <= 4096);
    const small = decodePng(await qr.png('BR-000001', { size: 3 }));
    assert.ok(small.width >= 100, 'never smaller than a readable minimum');
  });

  it('SVG output is a self-contained vector image carrying a quiet zone', async () => {
    const svg = await qr.svg('BR-000001');
    assert.match(svg, /^<\?xml|^<svg/);
    assert.match(svg, /viewBox="0 0 \d+ \d+"/);
    assert.ok(!svg.includes('<script'));
    assert.ok(!svg.includes('example.com'));
  });

  it('uses the configured error-correction level (default Q = 25 %)', async () => {
    const q = createQrService(testConfig({ QR_ERROR_CORRECTION: 'Q' }));
    const h = createQrService(testConfig({ QR_ERROR_CORRECTION: 'H' }));
    const svgQ = await q.svg('BR-000001');
    const svgH = await h.svg('BR-000001');
    const size = (s) => Number(/viewBox="0 0 (\d+)/.exec(s)[1]);
    assert.ok(size(svgH) >= size(svgQ), 'higher correction never produces a smaller symbol');
    assert.equal(decodePng(await h.png('BR-000001')).text, 'https://barcode.test/b/BR-000001');
  });

  it('a damaged printout (a blot over the middle of the data area) still decodes at level Q', async () => {
    const png = PNG.sync.read(await qr.png('BR-000042', { size: 1024 }));
    // Blot out a block in the data area: away from the three finder patterns, the timing lines
    // and the alignment pattern (lower right), which are located by the reader, not error-corrected.
    const bx = Math.floor(png.width * 0.42);
    const by = Math.floor(png.height * 0.40);
    const bw = Math.floor(png.width * 0.12);
    for (let y = by; y < by + bw; y += 1) {
      for (let x = bx; x < bx + bw; x += 1) {
        const i = (y * png.width + x) * 4;
        png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 255;
      }
    }
    const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.equal(result?.data, 'https://barcode.test/b/BR-000042');
  });

  it('APP_URL comes from configuration, never from a request header', () => {
    const other = createQrService(testConfig({ APP_URL: 'https://kampus.example.ac.id/' }));
    assert.equal(other.redirectUrl('BR-000001'), 'https://kampus.example.ac.id/b/BR-000001');
    assert.equal(qr.redirectUrl('BR-000001'), 'https://barcode.test/b/BR-000001');
  });
});
