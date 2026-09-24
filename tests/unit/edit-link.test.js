import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editLinkUrl, generateEditToken, isEditToken } from '../../src/lib/edit-token.js';
import { redactUrl } from '../../src/lib/redact.js';
import { validateBarcodeInput, validateTarget } from '../../src/modules/barcodes/barcodes.validation.js';

const ctx = { appOrigin: 'https://barcode.test', timezone: 'Asia/Jakarta' };

describe('edit link secret', () => {
  it('is 256 random bits in 43 URL-safe characters, and never repeats', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i += 1) {
      const token = generateEditToken();
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      seen.add(token);
    }
    assert.equal(seen.size, 2000);
  });

  it('accepts only that exact shape (so junk never reaches the database)', () => {
    assert.equal(isEditToken(generateEditToken()), true);
    for (const bad of ['', 'x', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, `${'A'.repeat(43)}\n`, ` ${'A'.repeat(42)}`, `${'A'.repeat(42)}/`, '../'.repeat(15), null, undefined, 42, {}, ['A'.repeat(43)]]) {
      assert.equal(isEditToken(bad), false, String(bad));
    }
  });

  it('builds the link from APP_URL, never from a request', () => {
    assert.equal(editLinkUrl({ appUrl: 'https://barcode.contoh.id' }, 'T'.repeat(43)), `https://barcode.contoh.id/e/${'T'.repeat(43)}`);
  });
});

describe('redactUrl (what may appear in logs)', () => {
  it('masks the secret in edit links, whatever follows it', () => {
    assert.equal(redactUrl('/e/abcDEF123'), '/e/[redacted]');
    assert.equal(redactUrl(`/e/${'k'.repeat(43)}?saved=1`), '/e/[redacted]');
    assert.equal(redactUrl('/e/abc/lagi'), '/e/[redacted]/lagi');
    assert.equal(redactUrl('/E/ABC'), '/e/[redacted]', 'case-insensitive');
    assert.equal(redactUrl('/e/abc#bagian'), '/e/[redacted]');
  });

  it('leaves everything else alone, minus query strings', () => {
    assert.equal(redactUrl('/b/BR-000001'), '/b/BR-000001');
    assert.equal(redactUrl('/admin/barcodes?q=rahasia&page=2'), '/admin/barcodes');
    assert.equal(redactUrl('/embed/x'), '/embed/x', 'only the /e/ prefix is special');
    assert.equal(redactUrl('/e'), '/e');
    assert.equal(redactUrl(null), '');
    assert.equal(redactUrl(undefined), '');
  });
});

describe('validateTarget', () => {
  it('validates type + value the same way for every caller', () => {
    assert.deepEqual(validateTarget({ target_type: 'url', target_value: 'https://contoh.com/x' }, ctx), { targetType: 'url', targetUrl: 'https://contoh.com/x', mapsInput: null, errors: {} });
    assert.equal(validateTarget({ target_type: 'phone', target_value: '0274123456' }, ctx).targetUrl, 'tel:+62274123456');
    assert.match(validateTarget({ target_type: 'url', target_value: 'javascript:alert(1)' }, ctx).errors.target_value, /http/);
    assert.match(validateTarget({ target_type: 'sms', target_value: '1' }, ctx).errors.target_type, /tidak dikenal/);
    assert.deepEqual(Object.keys(validateTarget({ target_type: 'whatsapp', target_value: 'x' }, ctx, { allowedTypes: ['url'] }).errors), ['target_type']);
  });

  it('accepts a blank destination only when asked to, and never a half-filled one', () => {
    const blank = { target_type: 'url', target_value: '   ', target_extra: '' };
    assert.deepEqual(validateTarget(blank, ctx, { allowEmpty: true }), { targetType: 'url', targetUrl: null, mapsInput: null, errors: {} });
    assert.match(validateTarget(blank, ctx).errors.target_value, /wajib diisi/, 'required by default');
    assert.deepEqual(validateTarget({ target_type: 'whatsapp' }, ctx, { allowEmpty: true }).targetUrl, null, 'missing fields count as blank');

    const half = { target_type: 'whatsapp', target_value: '', target_extra: 'Halo' };
    assert.ok(validateTarget(half, ctx, { allowEmpty: true }).errors.target_value, 'an extra text without a number is an error');
    assert.equal(validateTarget({ target_type: 'url', target_value: 'javascript:x' }, ctx, { allowEmpty: true }).targetUrl, null);
    assert.ok(validateTarget({ target_type: 'url', target_value: 'javascript:x' }, ctx, { allowEmpty: true }).errors.target_value, 'a filled value is still checked');
  });

  it('keeps the chosen type on a blank destination, so the form can reopen on it', () => {
    assert.equal(validateTarget({ target_type: 'whatsapp', target_value: '' }, ctx, { allowEmpty: true }).targetType, 'whatsapp');
  });

  it('a Google Maps destination is only CHECKED here (host, shape); turning it into a Place ID is the service\'s job', () => {
    const ok = validateTarget({ target_type: 'maps_review', target_value: '  maps.app.goo.gl/AZQV8dReQ9ZFcqjv6  ' }, ctx);
    assert.deepEqual(ok, { targetType: 'maps_review', targetUrl: null, mapsInput: 'https://maps.app.goo.gl/AZQV8dReQ9ZFcqjv6', errors: {} });

    assert.match(validateTarget({ target_type: 'maps_review', target_value: 'https://example.com/maps' }, ctx).errors.target_value, /dari Google Maps/);
    assert.match(validateTarget({ target_type: 'maps_review', target_value: '' }, ctx).errors.target_value, /wajib diisi/, 'required unless the barcode may stay empty');
    assert.deepEqual(validateTarget({ target_type: 'maps_review', target_value: '   ' }, ctx, { allowEmpty: true }), { targetType: 'maps_review', targetUrl: null, mapsInput: null, errors: {} });
    assert.ok(validateTarget({ target_type: 'maps_review', target_value: 'javascript:alert(1)' }, ctx, { allowEmpty: true }).errors.target_value, 'a filled value is still checked');
  });

  it('the CSV import cannot create Maps destinations (it only allows plain URLs)', () => {
    const res = validateTarget({ target_type: 'maps_review', target_value: 'https://maps.app.goo.gl/abc' }, ctx, { allowedTypes: ['url'] });
    assert.deepEqual(Object.keys(res.errors), ['target_type']);
  });
});

describe('validateBarcodeInput and the optional destination', () => {
  const base = { name: 'Stiker', description: '', status: 'active' };

  it('requires a destination unless allowEmptyTarget is set (CSV import keeps the strict behaviour)', () => {
    assert.match(validateBarcodeInput({ ...base, target_type: 'url', target_value: '' }, ctx).errors.target_value, /wajib diisi/);
    const relaxed = validateBarcodeInput({ ...base, target_type: 'url', target_value: '' }, ctx, { allowEmptyTarget: true });
    assert.deepEqual(relaxed.errors, {});
    assert.equal(relaxed.values.targetUrl, null);
  });

  it('still insists on a name, even for a barcode without a destination', () => {
    const res = validateBarcodeInput({ ...base, name: '  ', target_type: 'url', target_value: '' }, ctx, { allowEmptyTarget: true });
    assert.deepEqual(Object.keys(res.errors), ['name']);
  });
});
