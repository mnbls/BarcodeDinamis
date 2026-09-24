import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { UA, insertBarcodes, loginAgent, makeUser, postForm, scan, startApp } from '../helpers/app.js';

describe('redirect endpoint /b/{code}', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
  });

  it('redirects an active barcode with 302, never cacheable, and records exactly one scan', async () => {
    await insertBarcodes(t.ctx, [{ targetUrl: 'https://example.com/produk-a' }]);
    const res = await scan(t, 'BR-000001', { ua: UA.android, referer: 'https://www.instagram.com/p/abc?utm=1#frag' });
    assert.equal(res.status, 302, 'temporary redirect: a 301 would be cached by browsers and break edits');
    assert.equal(res.headers.location, 'https://example.com/produk-a');
    assert.match(res.headers['cache-control'], /no-store/);
    assert.match(res.headers['x-robots-tag'], /noindex/);
    const scans = await t.db.rows('SELECT * FROM barcode_scans');
    assert.equal(scans.length, 1);
    assert.equal(scans[0].device, 'mobile');
    assert.equal(scans[0].browser, 'Chrome');
    assert.equal(scans[0].operating_system, 'Android');
    assert.equal(scans[0].referer, 'https://www.instagram.com/p/abc', 'query string and fragment are stripped from the referer');
    assert.equal(scans[0].user_agent, UA.android);
    assert.equal(scans[0].ip_address, '127.0.0.1', 'IPv4-mapped IPv6 is normalised');
    assert.equal((await t.db.one('SELECT scan_count FROM barcodes')).scan_count, 1);
  });

  it('is case-insensitive on the code and tolerates surrounding noise in the path', async () => {
    await insertBarcodes(t.ctx, [{ targetUrl: 'https://example.com/x' }]);
    assert.equal((await scan(t, 'br-000001')).status, 302);
    assert.equal((await scan(t, 'Br-000001')).status, 302);
  });

  it('shows "Barcode Tidak Ditemukan" (404) and leaks nothing about the system', async () => {
    for (const code of ['BR-999999', 'XX-000001', 'not-a-code', "BR-1'OR'1", 'BR-000001%2F..', 'A'.repeat(200)]) {
      const res = await t.request().get(`/b/${encodeURIComponent(code)}`);
      assert.equal(res.status, 404, code);
      assert.match(res.text, /Barcode Tidak Ditemukan/);
      assert.ok(!/postgres|SELECT|stack|node_modules|at .*\.js|barcodes|localhost:\d+/i.test(res.text), `no internals for ${code}`);
    }
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_scans')).n, 0, 'unknown codes are not scans');
  });

  it('shows "Barcode Tidak Aktif" (403) for inactive barcodes without revealing the destination', async () => {
    await insertBarcodes(t.ctx, [{ status: 'inactive', targetUrl: 'https://rahasia.example.com/jangan-bocor' }]);
    const res = await scan(t, 'BR-000001');
    assert.equal(res.status, 403);
    assert.match(res.text, /Barcode Tidak Aktif/);
    assert.ok(!res.text.includes('rahasia.example.com'), 'destination must not leak');
    assert.equal(res.headers.location, undefined);
    assert.equal((await t.db.one('SELECT scan_count FROM barcodes')).scan_count, 0, 'blocked visits are not counted as scans');
  });

  it('shows "Barcode Sudah Tidak Berlaku" (410) once the expiry has passed', async () => {
    await insertBarcodes(t.ctx, [{ targetUrl: 'https://rahasia.example.com/x', expiredLocal: '2001-01-01 00:00:00' }]);
    const res = await scan(t, 'BR-000001');
    assert.equal(res.status, 410);
    assert.match(res.text, /Barcode Sudah Tidak Berlaku/);
    assert.ok(!res.text.includes('rahasia.example.com'));
    assert.equal((await t.db.one('SELECT scan_count FROM barcodes')).scan_count, 0);
  });

  it('checks status BEFORE expiry, and honours an expiry in the future', async () => {
    await insertBarcodes(t.ctx, [
      { status: 'inactive', expiredLocal: '2001-01-01 00:00:00' },
      { expiredLocal: '2099-01-01 00:00:00', targetUrl: 'https://example.com/masih-berlaku' },
    ]);
    assert.match((await scan(t, 'BR-000001')).text, /Tidak Aktif/);
    const ok = await scan(t, 'BR-000002');
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, 'https://example.com/masih-berlaku');
  });

  it('a barcode that expires while the server is running stops redirecting at that moment', async () => {
    await insertBarcodes(t.ctx, [{ targetUrl: 'https://example.com/x' }]);
    await t.db.query("UPDATE barcodes SET expired_at = now() + interval '1 second'");
    assert.equal((await scan(t, 'BR-000001')).status, 302);
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal((await scan(t, 'BR-000001')).status, 410);
  });

  it('records device / browser / OS for a range of agents and treats crawlers as bots', async () => {
    await insertBarcodes(t.ctx, [{}]);
    for (const ua of [UA.iphone, UA.windowsChrome, UA.windowsEdge, UA.macSafari, UA.firefox, UA.ipad, UA.samsung, UA.googlebot, UA.curl]) await scan(t, 'BR-000001', { ua });
    const rows = await t.db.rows('SELECT device, browser, operating_system FROM barcode_scans ORDER BY id');
    assert.deepEqual(rows.map((r) => `${r.device}/${r.browser}/${r.operating_system}`), [
      'mobile/Safari/iOS', 'desktop/Chrome/Windows', 'desktop/Edge/Windows', 'desktop/Safari/macOS', 'desktop/Firefox/Windows',
      'tablet/Safari/iOS', 'mobile/Samsung Internet/Android', 'bot/Bot/Other', 'bot/Bot/Other',
    ]);
  });

  it('sanitises absurd headers before storing them', async () => {
    await insertBarcodes(t.ctx, [{}]);
    await scan(t, 'BR-000001', { ua: `${UA.android} ${'A'.repeat(4000)}`, referer: `https://x.test/${'p'.repeat(4000)}` });
    const row = await t.db.one('SELECT user_agent, referer FROM barcode_scans');
    assert.equal(row.user_agent.length, 512);
    assert.ok(row.referer.length <= 512);
    await scan(t, 'BR-000001', { referer: 'javascript:alert(1)' });
    await scan(t, 'BR-000001', { referer: 'not a url' });
    const refs = await t.db.rows('SELECT referer FROM barcode_scans ORDER BY id');
    assert.equal(refs[1].referer, null);
    assert.equal(refs[2].referer, null);
  });

  it('does not count HEAD requests or browser prefetches as scans', async () => {
    await insertBarcodes(t.ctx, [{}]);
    const head = await scan(t, 'BR-000001', { method: 'head' });
    assert.equal(head.status, 302);
    await t.request().get('/b/BR-000001').set('Sec-Purpose', 'prefetch');
    await t.ctx.recorder.idle();
    assert.equal((await t.db.one('SELECT scan_count FROM barcodes')).scan_count, 0);
    await scan(t, 'BR-000001');
    assert.equal((await t.db.one('SELECT scan_count FROM barcodes')).scan_count, 1);
  });

  it('counts concurrent scans exactly (no lost updates on the counter or the rollup)', async () => {
    await insertBarcodes(t.ctx, [{}]);
    await Promise.all(Array.from({ length: 60 }, (_, i) => t.request().get('/b/BR-000001').set('User-Agent', i % 2 ? UA.android : UA.windowsChrome)));
    await t.ctx.recorder.idle();
    assert.equal((await t.db.one('SELECT scan_count FROM barcodes')).scan_count, 60);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcode_scans')).n, 60);
    assert.equal((await t.db.one('SELECT sum(scans)::int AS n FROM scan_stats_daily')).n, 60);
    const groups = await t.db.rows('SELECT device, scans FROM scan_stats_daily ORDER BY device');
    assert.deepEqual(groups.map((g) => [g.device, g.scans]), [['desktop', 30], ['mobile', 30]]);
  });

  it('hands mailto:/tel: destinations off through a tiny page, still recording the scan', async () => {
    await insertBarcodes(t.ctx, [
      { targetType: 'email', targetUrl: 'mailto:halo@contoh.co.id?subject=Tanya' },
      { targetType: 'phone', targetUrl: 'tel:+62274123456' },
    ]);
    const mail = await scan(t, 'BR-000001');
    assert.equal(mail.status, 200);
    assert.match(mail.text, /http-equiv="refresh" content="0;url=mailto:halo@contoh\.co\.id\?subject=Tanya"/);
    assert.match(mail.text, /href="mailto:halo@contoh\.co\.id\?subject=Tanya"/);
    const tel = await scan(t, 'BR-000002');
    assert.match(tel.text, /url=tel:\+62274123456/);
    assert.equal((await t.db.one('SELECT sum(scan_count)::int AS n FROM barcodes')).n, 2);
  });

  it('keeps redirecting (and the scan recorded) when the scan write fails', async () => {
    await insertBarcodes(t.ctx, [{ targetUrl: 'https://example.com/tetap-jalan' }]);
    await t.db.query('ALTER TABLE barcode_scans RENAME TO barcode_scans_x');
    try {
      const res = await scan(t, 'BR-000001');
      assert.equal(res.status, 302, 'analytics failure must never break a redirect');
      assert.equal(res.headers.location, 'https://example.com/tetap-jalan');
    } finally {
      await t.db.query('ALTER TABLE barcode_scans_x RENAME TO barcode_scans');
    }
  });

  it('the redirect path needs no session, no cookies and sets none', async () => {
    await insertBarcodes(t.ctx, [{}]);
    const res = await t.request().get('/b/BR-000001');
    assert.equal(res.headers['set-cookie'], undefined);
    const sessions = await t.db.one('SELECT count(*)::int AS n FROM user_sessions');
    assert.equal(sessions.n, 0);
  });

  it('only GET (and HEAD) can redirect: other verbs are never scans', async () => {
    await insertBarcodes(t.ctx, [{}]);
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const res = await t.request()[method]('/b/BR-000001');
      assert.ok([403, 404, 405].includes(res.status), `${method} -> ${res.status}`);
      assert.equal(res.headers.location, undefined);
    }
    await t.ctx.recorder.idle();
    assert.equal((await t.db.one('SELECT scan_count FROM barcodes')).scan_count, 0);
  });
});

describe('redirect cache and rate limiting', () => {
  it('with a cache TTL, edits made through the admin apply immediately (invalidation) and other data stays cached', async () => {
    const t = await startApp({ REDIRECT_CACHE_TTL_MS: '60000' });
    try {
      await makeUser(t.ctx, { username: 'admin' });
      const admin = await loginAgent(t);
      await insertBarcodes(t.ctx, [{ targetUrl: 'https://example.com/lama' }, { targetUrl: 'https://example.com/lain' }]);

      assert.equal((await scan(t, 'BR-000001')).headers.location, 'https://example.com/lama');
      assert.equal((await scan(t, 'BR-000002')).headers.location, 'https://example.com/lain');
      assert.equal(t.ctx.cache.size, 2);

      // change the row behind the cache's back: the cached value is served (this is what the TTL means)
      await t.db.query("UPDATE barcodes SET target_url = 'https://example.com/diam-diam' WHERE code = 'BR-000002'");
      assert.equal((await scan(t, 'BR-000002')).headers.location, 'https://example.com/lain');

      // ...but every admin write invalidates immediately
      await postForm(admin, '/admin/barcodes/BR-000001', { name: 'x', target_type: 'url', target_value: 'https://example.com/baru', status: 'active' }, { tokenPage: '/admin/barcodes/BR-000001/edit' });
      assert.equal((await scan(t, 'BR-000001')).headers.location, 'https://example.com/baru');

      await postForm(admin, '/admin/barcodes/BR-000001/status', { status: 'inactive' }, { tokenPage: '/admin' });
      assert.equal((await scan(t, 'BR-000001')).status, 403);
      await postForm(admin, '/admin/barcodes/BR-000001/delete', {}, { tokenPage: '/admin' });
      assert.equal((await scan(t, 'BR-000001')).status, 404);
    } finally {
      await t.close();
    }
  });

  it('a stale read that started before an invalidation is not written back into the cache', async () => {
    const { createRedirectCache } = await import('../../src/modules/redirect/redirect.cache.js');
    const cache = createRedirectCache(60000);
    const generation = cache.generation; // reader starts
    cache.invalidate('BR-000001'); // admin edit lands
    cache.set('BR-000001', { target_url: 'stale' }, generation); // reader finishes late
    assert.equal(cache.get('BR-000001'), undefined);
    cache.set('BR-000001', { target_url: 'fresh' }, cache.generation);
    assert.equal(cache.get('BR-000001').target_url, 'fresh');
  });

  it('throttles enumeration: many unknown codes from one IP get 429, while real codes keep working', async () => {
    const t = await startApp({ REDIRECT_404_RATE_LIMIT_MAX: '5' });
    try {
      await insertBarcodes(t.ctx, [{ targetUrl: 'https://example.com/ok' }]);
      const statuses = [];
      for (let i = 0; i < 9; i += 1) statuses.push((await t.request().get(`/b/BR-9000${i}`)).status);
      assert.deepEqual(statuses.slice(0, 5), [404, 404, 404, 404, 404]);
      assert.ok(statuses.slice(5).every((s) => s === 429), `after the budget: ${statuses.slice(5)}`);
      const limited = await t.request().get('/b/BR-90009');
      assert.match(limited.text, /Terlalu Banyak Permintaan/);
      assert.ok(limited.headers['retry-after']);
    } finally {
      await t.close();
    }
  });

  it('expired / inactive pages do not consume the enumeration budget (campus NAT scanning an old poster)', async () => {
    const t = await startApp({ REDIRECT_404_RATE_LIMIT_MAX: '3' });
    try {
      await insertBarcodes(t.ctx, [{ expiredLocal: '2001-01-01 00:00:00' }]);
      for (let i = 0; i < 10; i += 1) assert.equal((await t.request().get('/b/BR-000001')).status, 410);
    } finally {
      await t.close();
    }
  });

  it('applies the general per-IP limit to the redirect endpoint', async () => {
    const t = await startApp({ REDIRECT_RATE_LIMIT_MAX: '4' });
    try {
      await insertBarcodes(t.ctx, [{}]);
      const statuses = [];
      for (let i = 0; i < 6; i += 1) statuses.push((await t.request().get('/b/BR-000001')).status);
      assert.deepEqual(statuses, [302, 302, 302, 302, 429, 429]);
    } finally {
      await t.close();
    }
  });

  it('uses the client IP behind a trusted proxy, ignores X-Forwarded-For otherwise, and can anonymise IPs', async () => {
    const proxied = await startApp({ TRUST_PROXY: '1' });
    try {
      await insertBarcodes(proxied.ctx, [{}]);
      await scan(proxied, 'BR-000001', { ip: '203.0.113.77' });
      assert.equal((await proxied.db.one('SELECT host(ip_address) AS ip FROM barcode_scans')).ip, '203.0.113.77');
    } finally {
      await proxied.close();
    }
    const direct = await startApp({ TRUST_PROXY: '0' });
    try {
      await insertBarcodes(direct.ctx, [{}]);
      await scan(direct, 'BR-000001', { ip: '203.0.113.77' });
      assert.equal((await direct.db.one('SELECT host(ip_address) AS ip FROM barcode_scans')).ip, '127.0.0.1', 'spoofed header ignored without TRUST_PROXY');
    } finally {
      await direct.close();
    }
    const anon = await startApp({ TRUST_PROXY: '1', IP_ANONYMIZE: 'true' });
    try {
      await insertBarcodes(anon.ctx, [{}]);
      await scan(anon, 'BR-000001', { ip: '203.0.113.77' });
      assert.equal((await anon.db.one('SELECT host(ip_address) AS ip FROM barcode_scans')).ip, '203.0.113.0');
    } finally {
      await anon.close();
    }
  });
});
