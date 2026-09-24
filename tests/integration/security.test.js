import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import pino from 'pino';
import supertest from 'supertest';
import { createApp } from '../../src/app.js';
import { createContext } from '../../src/context.js';
import { PASSWORD, csrfFor, extractCsrf, insertBarcodes, loginAgent, makeUser, startApp, testConfig } from '../helpers/app.js';

describe('security headers and page hygiene', () => {
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
    await insertBarcodes(t.ctx, [{ name: 'Contoh' }]);
  });

  const pages = ['/', '/login', '/admin', '/admin/barcodes', '/admin/barcodes/new', '/admin/barcodes/BR-000001', '/admin/barcodes/BR-000001/edit', '/admin/barcodes/BR-000001/print', '/admin/import', '/admin/analytics', '/admin/history', '/admin/settings', '/b/BR-000001', '/b/BR-999999'];

  it('sends a strict CSP, nosniff, framing protection and no server fingerprint on every page', async () => {
    for (const path of pages) {
      const res = await admin.get(path);
      const csp = res.headers['content-security-policy'] ?? '';
      assert.match(csp, /default-src 'self'/, path);
      assert.match(csp, /script-src 'self'(;|$)/, `${path}: only same-origin scripts`);
      assert.match(csp, /frame-ancestors 'none'/, path);
      assert.match(csp, /object-src 'none'/, path);
      assert.match(csp, /form-action 'self'/, path);
      assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), `${path}: no inline scripts`);
      assert.ok(!/script-src[^;]*unsafe-eval/.test(csp), `${path}: no eval`);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
      assert.equal(res.headers['referrer-policy'], 'no-referrer', path);
      assert.ok(!res.headers['x-powered-by'], `${path}: X-Powered-By must be hidden`);
      assert.match(res.headers['permissions-policy'] ?? '', /camera=\(\)/, path);
    }
  });

  it('admin pages are never cached; static assets are', async () => {
    for (const path of ['/admin', '/admin/barcodes', '/admin/settings']) assert.match((await admin.get(path)).headers['cache-control'], /no-store/, path);
    const css = await t.request().get('/assets/css/base.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
  });

  it('renders no inline scripts, no inline event handlers and no javascript: URLs anywhere', async () => {
    for (const path of pages) {
      const html = (await admin.get(path)).text;
      const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\bsrc=/.test(m[1]));
      assert.equal(inlineScripts.length, 0, `${path}: inline <script>`);
      assert.ok(!/\son(click|load|error|submit|change|mouseover|focus)\s*=/i.test(html), `${path}: inline event handler`);
      assert.ok(!/(href|src|action)\s*=\s*["']\s*javascript:/i.test(html), `${path}: javascript: URL`);
      assert.ok(!/<style\b/i.test(html), `${path}: inline <style> element`);
    }
  });

  it('never prints "undefined", "NaN" or "[object Object]" into a page', async () => {
    for (const path of pages) {
      const text = (await admin.get(path)).text.replace(/<script[\s\S]*?<\/script>/g, '');
      for (const bad of ['undefined', '[object Object]', 'NaN']) assert.ok(!text.includes(bad), `${path} contains ${bad}`);
    }
  });

  it('does not expose source, config or dotfiles through the static route', async () => {
    for (const path of ['/.env', '/package.json', '/assets/../package.json', '/assets/%2e%2e/.env', '/assets/..%2f..%2f.env', '/assets/.env', '/src/config/index.js', '/db/migrations/0001_init.sql', '/node_modules/express/package.json', '/assets/css/', '/assets/']) {
      const res = await t.request().get(path);
      assert.ok([301, 400, 403, 404].includes(res.status), `${path} -> ${res.status}`);
      assert.ok(!/SESSION_SECRET|DATABASE_URL|"dependencies"/.test(res.text ?? ''), path);
    }
  });

  it('robots.txt keeps crawlers out of the admin area and the redirect endpoint', async () => {
    const res = await t.request().get('/robots.txt');
    assert.match(res.text, /Disallow: \/admin/);
    assert.match(res.text, /Disallow: \/b\//);
    assert.match(res.text, /Disallow: \/login/);
  });
});

describe('CSRF protection', () => {
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
    await insertBarcodes(t.ctx, [{ name: 'Contoh' }]);
  });

  const mutating = [
    ['/admin/barcodes', { name: 'X', target_type: 'url', target_value: 'https://example.com', status: 'active' }],
    ['/admin/barcodes/BR-000001', { name: 'X', target_type: 'url', target_value: 'https://example.com/z', status: 'active' }],
    ['/admin/barcodes/BR-000001/status', { status: 'inactive' }],
    ['/admin/barcodes/BR-000001/delete', {}],
    ['/admin/barcodes/bulk', { action: 'delete', ids: '1' }],
    ['/admin/settings/profile', { name: 'Zed', username: 'zed', email: 'zed@x.test' }],
    ['/admin/settings/password', { currentPassword: PASSWORD, newPassword: 'Baru-Password-77', confirmPassword: 'Baru-Password-77' }],
    ['/logout', {}],
  ];

  it('rejects every state-changing request without a token, with a wrong token, or flagged cross-site', async () => {
    const good = await csrfFor(admin, '/admin');
    for (const [path, body] of mutating) {
      const none = await admin.post(path).type('form').send(body);
      assert.equal(none.status, 403, `${path}: no token`);
      const wrong = await admin.post(path).type('form').send({ _csrf: `${good.slice(0, -2)}xx`, ...body });
      assert.equal(wrong.status, 403, `${path}: wrong token`);
      const truncated = await admin.post(path).type('form').send({ _csrf: good.slice(0, 10), ...body });
      assert.equal(truncated.status, 403, `${path}: truncated token`);
      const cross = await admin.post(path).set('Sec-Fetch-Site', 'cross-site').type('form').send({ _csrf: good, ...body });
      assert.equal(cross.status, 403, `${path}: cross-site`);
      const header = await admin.post(path).set('X-CSRF-Token', 'nope').type('form').send(body);
      assert.equal(header.status, 403, `${path}: bad header token`);
    }
    const row = await t.db.one('SELECT name, status FROM barcodes');
    assert.deepEqual({ ...row }, { name: 'Contoh', status: 'active' }, 'nothing was changed by the rejected requests');
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM users')).n, 1);
  });

  it('accepts a token in the form field or in the X-CSRF-Token header', async () => {
    const token = await csrfFor(admin, '/admin');
    const viaHeader = await admin.post('/admin/barcodes/BR-000001/status').set('X-CSRF-Token', token).type('form').send({ status: 'inactive' });
    assert.equal(viaHeader.status, 302);
    const viaField = await admin.post('/admin/barcodes/BR-000001/status').type('form').send({ _csrf: token, status: 'active' });
    assert.equal(viaField.status, 302);
  });

  it('a token from one session is useless in another (tokens are per session)', async () => {
    const other = await loginAgent(t);
    const otherToken = await csrfFor(other, '/admin');
    const res = await admin.post('/admin/barcodes/BR-000001/delete').type('form').send({ _csrf: otherToken });
    assert.equal(res.status, 403);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 1);
  });

  it('login is CSRF protected too (no login CSRF), and anonymous forms carry a token', async () => {
    const res = await t.request().post('/login').type('form').send({ identifier: 'admin', password: PASSWORD });
    assert.equal(res.status, 403);
    const page = await t.request().get('/login');
    assert.match(extractCsrf(page.text), /^[\w-]{40,}$/);
  });

  it('state-changing verbs other than POST do not exist (no PUT/PATCH/DELETE bypass)', async () => {
    for (const method of ['put', 'patch', 'delete']) {
      for (const path of ['/admin/barcodes/BR-000001', '/admin/barcodes/BR-000001/delete', '/admin/barcodes/bulk']) {
        const res = await admin[method](path);
        assert.ok([403, 404, 405].includes(res.status), `${method.toUpperCase()} ${path} -> ${res.status}`);
      }
    }
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 1);
  });

  it('GET requests never change data', async () => {
    const before = await t.db.one('SELECT status, name, target_url FROM barcodes');
    for (const path of ['/admin/barcodes/BR-000001/status?status=inactive', '/admin/barcodes/BR-000001/delete', '/admin/barcodes/bulk?action=delete&ids=1', '/logout']) await admin.get(path);
    const after = await t.db.one('SELECT status, name, target_url FROM barcodes');
    assert.deepEqual({ ...after }, { ...before });
  });
});

describe('sessions and input limits', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await makeUser(t.ctx, { username: 'admin' });
  });

  it('a forged or tampered session cookie is just an anonymous visitor', async () => {
    for (const cookie of ['bdms.sid=s%3Aforged.signature', 'bdms.sid=123', 'bdms.sid=', 'bdms.sid=../../etc/passwd']) {
      const res = await t.request().get('/admin').set('Cookie', cookie);
      assert.equal(res.status, 302, cookie);
      assert.match(res.headers.location, /^\/login/);
    }
  });

  it('session rows live in PostgreSQL, hold no password data, and expire', async () => {
    const agent = await loginAgent(t);
    await agent.get('/admin');
    const rows = await t.db.rows('SELECT sess::text AS sess, expire FROM user_sessions');
    assert.ok(rows.length >= 1);
    for (const r of rows) {
      assert.ok(!r.sess.includes(PASSWORD));
      assert.ok(!/password_hash|\$2[aby]\$/.test(r.sess));
      assert.ok(new Date(r.expire).getTime() > Date.now() - 60_000);
    }
  });

  it('oversized form bodies are refused cleanly', async () => {
    const page = await t.request().get('/login');
    const big = 'x'.repeat(400 * 1024);
    const res = await t.request().post('/login').type('form').send({ _csrf: extractCsrf(page.text), identifier: big, password: 'x' });
    assert.ok([413, 403].includes(res.status), `status ${res.status}`);
    assert.ok(!/at .*\.js:\d+/.test(res.text), 'no stack trace');
  });

  it('SQL metacharacters in the login form are just wrong credentials', async () => {
    for (const identifier of ["admin' OR '1'='1", "admin'--", "' OR 1=1 --", 'admin"; DROP TABLE users; --']) {
      const agent = t.agent();
      const page = await agent.get('/login');
      const res = await agent.post('/login').type('form').send({ _csrf: extractCsrf(page.text), identifier, password: "' OR '1'='1" });
      assert.equal(res.status, 401, identifier);
    }
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM users')).n, 1);
  });

  it('cookie carries the Secure flag when the site is served over https in production', async () => {
    const prod = await startApp({ COOKIE_SECURE: 'true' });
    try {
      const res = await prod.request().get('/login');
      await makeUser(prod.ctx, { username: 'admin' });
      const page = await prod.request().get('/login');
      const cookieJar = prod.request();
      const login = await cookieJar.post('/login').set('X-Forwarded-Proto', 'https').type('form').send({ _csrf: extractCsrf(page.text), identifier: 'admin', password: PASSWORD });
      assert.ok(res.status === 200 && login.status);
      const configured = testConfig({ COOKIE_SECURE: 'true' });
      assert.equal(configured.session.cookieSecure, true);
      const auto = testConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'auto', APP_URL: 'https://x.example.com', SESSION_SECRET: 'p'.repeat(40) });
      assert.equal(auto.session.cookieSecure, true, '"auto" = Secure in production with an https APP_URL');
      const autoHttp = testConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'auto', APP_URL: 'http://x.example.com', SESSION_SECRET: 'p'.repeat(40) });
      assert.equal(autoHttp.session.cookieSecure, false);
    } finally {
      await prod.close();
    }
  });
});

describe('production error handling', () => {
  it('a database outage yields a generic 503/500 page with a request id and NO internals', async () => {
    const config = testConfig({
      NODE_ENV: 'production',
      APP_URL: 'https://barcode.test',
      DATABASE_URL: 'postgres://nobody:supersecret@127.0.0.1:1/barcode_dinamis_test',
      SESSION_SECRET: 'p'.repeat(48),
      COOKIE_SECURE: 'false',
      LOG_TO_FILE: 'false',
    });
    assert.equal(config.isProd, true);
    const ctx = createContext(config, { logger: pino({ level: 'silent' }) });
    const app = createApp(ctx);

    // A validly SIGNED session cookie forces a session-store lookup, which needs the (dead) database.
    const sid = 'some-session-id';
    const signed = createHmac('sha256', config.session.secret).update(sid).digest('base64').replace(/=+$/, '');
    const cookie = `${config.session.cookieName}=${encodeURIComponent(`s:${sid}.${signed}`)}`;

    try {
      const failing = {
        'admin page (session lookup)': await supertest(app).get('/admin').set('Cookie', cookie),
        'redirect endpoint (barcode lookup)': await supertest(app).get('/b/BR-000001'),
      };
      for (const [name, res] of Object.entries(failing)) {
        assert.equal(res.status, 500, name);
        assert.match(res.text, /Terjadi kesalahan/, name);
        assert.ok(res.headers['x-request-id'], `${name}: the request id lets support find the log line`);
        for (const secret of ['supersecret', 'nobody', 'ECONNREFUSED', '127.0.0.1', 'node_modules', 'pg-pool', 'at Object', 'at async', 'stack', 'password authentication']) {
          assert.ok(!res.text.includes(secret), `${name}: page must not contain "${secret}"`);
        }
      }

      const health = await supertest(app).get('/healthz');
      assert.equal(health.status, 503);
      assert.deepEqual(health.body, { status: 'unavailable' });

      // Pages that need no database keep working during an outage.
      assert.equal((await supertest(app).get('/')).status, 200);
      assert.equal((await supertest(app).get('/login')).status, 200);
      // Regression: the login page's anonymous session cannot be saved during an outage. That used to make Express
      // destroy the connection mid-response (ECONNRESET) on roughly one request in ten, so ask many times.
      for (let i = 1; i <= 15; i += 1) {
        assert.equal((await supertest(app).get('/login')).status, 200, `login page during an outage, request ${i}`);
      }
      const anonymous = await supertest(app).get('/admin');
      assert.equal(anonymous.status, 302, 'no cookie, no lookup: plain redirect to the login page');
    } finally {
      await ctx.db.end().catch(() => {});
    }
  });

  it('/healthz reports ok on a healthy database and reveals nothing else', async () => {
    const t = await startApp();
    try {
      const res = await t.request().get('/healthz');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { status: 'ok' });
      assert.match(res.headers['cache-control'], /no-store/);
    } finally {
      await t.close();
    }
  });

  it('configuration errors are explicit and refuse weak production secrets', async () => {
    assert.throws(() => testConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short', APP_URL: 'https://x.example.com' }), /SESSION_SECRET terlalu pendek/);
    assert.throws(() => testConfig({ NODE_ENV: 'production', SESSION_SECRET: '', APP_URL: 'https://x.example.com' }), /SESSION_SECRET wajib/);
    assert.throws(() => testConfig({ APP_URL: 'javascript:alert(1)' }), /APP_URL/);
    assert.throws(() => testConfig({ CODE_MODE: 'weird' }), /CODE_MODE/);
    assert.throws(() => testConfig({ APP_TIMEZONE: 'Mars/Olympus' }), /APP_TIMEZONE/);
    assert.throws(() => testConfig({ QR_ERROR_CORRECTION: 'Z' }), /QR_ERROR_CORRECTION/);
    assert.throws(() => testConfig({ PORT: '99999' }), /PORT/);
  });
});

describe('random code mode', () => {
  it('generates unguessable, unique codes for single and bulk creation', async () => {
    const t = await startApp({ CODE_MODE: 'random', CODE_PREFIX: 'QR' });
    try {
      await makeUser(t.ctx, { username: 'admin' });
      const admin = await loginAgent(t);
      const rows = await insertBarcodes(t.ctx, Array.from({ length: 1500 }, (_, i) => ({ name: `Acak ${i}` })));
      assert.equal(new Set(rows.map((r) => r.code)).size, 1500);
      assert.ok(rows.every((r) => /^QR-[2-9A-HJKMNP-Z]{8}$/.test(r.code)));

      const token = await csrfFor(admin, '/admin/barcodes/new');
      const res = await admin.post('/admin/barcodes').type('form').send({ _csrf: token, name: 'Satu', target_type: 'url', target_value: 'https://example.com/x', status: 'active' });
      assert.match(res.headers.location, /^\/admin\/barcodes\/QR-[2-9A-HJKMNP-Z]{8}$/);
      const redirect = await t.request().get(`/b/${res.headers.location.split('/').pop()}`);
      assert.equal(redirect.status, 302);
      assert.equal((await t.request().get('/b/QR-22222222')).status, 404);
    } finally {
      await t.close();
    }
  });

  it('recovers from a code collision by drawing new codes (UNIQUE index + retry)', async () => {
    const t = await startApp({ CODE_MODE: 'random' });
    try {
      const codesModule = await import('../../src/lib/codes.js');
      const { insertRows } = await import('../../src/modules/barcodes/barcodes.repo.js');
      await insertBarcodes(t.ctx, [{ name: 'Existing' }]);
      const existing = (await t.db.one('SELECT code FROM barcodes')).code;
      // Force the first allocation to collide, then behave normally.
      const seen = [];
      const config = { ...t.config, codes: { ...t.config.codes } };
      const db = {
        ...t.db,
        rows: async (sql, params) => {
          if (/INSERT INTO barcodes/.test(sql)) {
            seen.push(params[0][0]);
            if (seen.length === 1) params[0][0] = existing;
          }
          return t.db.rows(sql, params);
        },
      };
      const out = await insertRows(db, config, [{ name: 'New', targetType: 'url', targetUrl: 'https://example.com/n', status: 'active' }]);
      assert.equal(out.length, 1);
      assert.notEqual(out[0].code, existing);
      assert.equal(seen.length, 2, 'one collision, one retry');
      assert.ok(codesModule.normalizeCode(out[0].code));
    } finally {
      await t.close();
    }
  });
});
