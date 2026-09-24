import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTarget, needsHandoffPage, normalizePhoneDigits, parseTarget, validateWebUrl } from '../../src/modules/barcodes/targets.js';

const APP = 'https://barcode.test';

describe('validateWebUrl: only http(s) destinations are allowed', () => {
  it('accepts http and https URLs and normalises them', () => {
    assert.deepEqual(validateWebUrl('https://example.com/a?x=1#y'), { ok: true, url: 'https://example.com/a?x=1#y' });
    assert.equal(validateWebUrl('http://example.com').url, 'http://example.com/');
    assert.equal(validateWebUrl('  HTTPS://Example.COM/Path  ').url, 'https://example.com/Path');
    assert.equal(validateWebUrl('https://münchen.de/').url, 'https://xn--mnchen-3ya.de/');
  });

  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'mailto:a@b.co',
    'tel:+62812',
    '//evil.example.com/x',
    'example.com/no-scheme',
    'java\tscript:alert(1)',
    'https:/\\evil.com',
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.equal(validateWebUrl(bad).ok, false);
    });
  }

  it('rejects empty input, spaces, control characters and credentials', () => {
    assert.equal(validateWebUrl('').ok, false);
    assert.equal(validateWebUrl('   ').ok, false);
    assert.match(validateWebUrl('https://example.com/a b').error, /spasi/);
    assert.equal(validateWebUrl('https://example.com/a\nb').ok, false);
    assert.equal(validateWebUrl('https://example.com/a\u0000b').ok, false);
    assert.match(validateWebUrl('https://user:pass@example.com/').error, /username/);
    assert.equal(validateWebUrl('https://google.com@evil.com/').ok, false);
  });

  it('rejects overly long URLs (2048 characters is the limit)', () => {
    const ok = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
    assert.equal(ok.length, 2048);
    assert.equal(validateWebUrl(ok).ok, true);
    assert.equal(validateWebUrl(`${ok}a`).ok, false);
  });

  it('blocks destinations that point back into this system (redirect loops)', () => {
    assert.equal(validateWebUrl(`${APP}/b/BR-000001`, { appOrigin: APP }).ok, false);
    assert.equal(validateWebUrl(`${APP}/B/BR-000001?x=1`, { appOrigin: APP }).ok, false);
    assert.equal(validateWebUrl(`${APP}/landing`, { appOrigin: APP }).ok, true, 'other pages of the same host are fine');
    assert.equal(validateWebUrl('https://other.test/b/BR-000001', { appOrigin: APP }).ok, true);
  });
});

describe('buildTarget', () => {
  it('builds WhatsApp links from local and international numbers', () => {
    assert.equal(buildTarget('whatsapp', { value: '0812-3456-7890' }).targetUrl, 'https://wa.me/6281234567890');
    assert.equal(buildTarget('whatsapp', { value: '+62 812 3456 7890', extra: 'Halo, saya mau pesan & tanya' }).targetUrl, 'https://wa.me/6281234567890?text=Halo%2C%20saya%20mau%20pesan%20%26%20tanya');
    assert.equal(buildTarget('whatsapp', { value: '0062812345678' }).targetUrl, 'https://wa.me/62812345678');
    assert.equal(buildTarget('whatsapp', { value: 'abc' }).ok, false);
    assert.equal(buildTarget('whatsapp', { value: '123' }).ok, false);
  });

  it('builds mailto: links with encoded subject', () => {
    assert.equal(buildTarget('email', { value: 'Halo@Contoh.co.id', extra: 'Tanya produk A' }).targetUrl, 'mailto:Halo@contoh.co.id?subject=Tanya%20produk%20A');
    assert.equal(buildTarget('email', { value: 'not-an-email' }).ok, false);
    assert.equal(buildTarget('email', { value: 'a@b' }).ok, false);
    assert.equal(buildTarget('email', { value: 'a b@c.com' }).ok, false);
    // header injection attempts cannot produce extra headers: everything is percent-encoded
    const r = buildTarget('email', { value: 'a@b.co', extra: 'x\r\nBcc: evil@x.co' });
    assert.ok(!/[\r\n]/.test(r.targetUrl));
  });

  it('builds tel: links', () => {
    assert.equal(buildTarget('phone', { value: '0274 123456' }).targetUrl, 'tel:+62274123456');
    assert.equal(buildTarget('phone', { value: '+1 (415) 555-2671' }).targetUrl, 'tel:+14155552671');
    assert.equal(buildTarget('phone', { value: 'javascript:1' }).ok, false);
  });

  it('never yields a dangerous scheme, whatever the type', () => {
    for (const type of ['url', 'whatsapp', 'email', 'phone']) {
      for (const evil of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x']) {
        const r = buildTarget(type, { value: evil, extra: evil }, { appOrigin: APP });
        if (r.ok) assert.match(r.targetUrl, /^(https?:\/\/|mailto:|tel:)/i);
      }
    }
    assert.equal(buildTarget('unknown', { value: 'x' }).ok, false);
  });

  it('parseTarget is the inverse of buildTarget (edit form pre-fill)', () => {
    const wa = buildTarget('whatsapp', { value: '081234567890', extra: 'Halo dunia' }).targetUrl;
    assert.deepEqual(parseTarget('whatsapp', wa), { value: '6281234567890', extra: 'Halo dunia' });
    const mail = buildTarget('email', { value: 'a.b+c@contoh.co.id', extra: 'Tes 1' }).targetUrl;
    assert.deepEqual(parseTarget('email', mail), { value: 'a.b+c@contoh.co.id', extra: 'Tes 1' });
    assert.deepEqual(parseTarget('phone', 'tel:+62274123456'), { value: '+62274123456', extra: '' });
    assert.deepEqual(parseTarget('url', 'https://x.test/a'), { value: 'https://x.test/a', extra: '' });
  });

  it('flags mailto:/tel: for the hand-off page and keeps http(s) as real redirects', () => {
    assert.equal(needsHandoffPage('mailto:a@b.co'), true);
    assert.equal(needsHandoffPage('tel:+62812'), true);
    assert.equal(needsHandoffPage('https://x.test'), false);
    assert.equal(normalizePhoneDigits('+62 (812) 000-111'), '62812000111');
  });
});
