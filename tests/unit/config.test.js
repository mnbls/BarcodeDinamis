import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config/index.js';

const BASE = { NODE_ENV: 'test', DATABASE_URL: 'postgres://user:pass@localhost:5432/contoh_test' };

describe('config: the two names', () => {
  it('the card brand is Riview Yuk unless BRAND_NAME says otherwise, and it is separate from the app name', () => {
    const plain = loadConfig(BASE);
    assert.equal(plain.brandName, 'Riview Yuk');
    assert.equal(plain.appName, 'Dynamic Barcode');

    const custom = loadConfig({ ...BASE, BRAND_NAME: 'Ulasan Kita', APP_NAME: 'Panel Kartu' });
    assert.equal(custom.brandName, 'Ulasan Kita');
    assert.equal(custom.appName, 'Panel Kartu', 'changing one never changes the other');
  });

  it('BRAND_NAME is trimmed, and an empty value falls back to the default', () => {
    assert.equal(loadConfig({ ...BASE, BRAND_NAME: '   Ulasan Kita  ' }).brandName, 'Ulasan Kita');
    assert.equal(loadConfig({ ...BASE, BRAND_NAME: '' }).brandName, 'Riview Yuk');
  });
});
