import dotenv from 'dotenv';
import supertest from 'supertest';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { createContext } from '../../src/context.js';
import { migrateUp } from '../../src/db/migrate.js';
import { buildPlaceId, reviewUrlFor } from '../../src/lib/google-maps.js';
import * as barcodes from '../../src/modules/barcodes/barcodes.repo.js';
import { createUser } from '../../src/modules/auth/auth.service.js';
import { createMapsResolver } from '../../src/modules/maps/maps.resolver.js';

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '..', '.env'), quiet: true });

export const PASSWORD = 'Sup3r-Secret-Pw';

/**
 * Test configuration. SAFETY: every test run truncates tables, so it refuses to touch any database whose
 * name does not end in "_test".
 */
export function testConfig(overrides = {}) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL belum diisi di .env (database khusus test).');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!/_test$/.test(dbName)) throw new Error(`Tes menolak berjalan: database "${dbName}" tidak berakhiran _test (tabelnya akan dikosongkan).`);

  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: url,
    APP_URL: 'https://barcode.test',
    APP_NAME: 'Dynamic Barcode', // names on screen must not depend on the developer's .env
    BRAND_NAME: 'Riview Yuk',
    APP_TIMEZONE: 'Asia/Jakarta',
    SESSION_SECRET: 'test-secret-'.padEnd(48, 'x'),
    BCRYPT_ROUNDS: '4',
    TRUST_PROXY: '0',
    CODE_MODE: 'sequential',
    CODE_PREFIX: 'BR',
    REDIRECT_CACHE_TTL_MS: '0',
    REDIRECT_RATE_LIMIT_MAX: '1000000',
    REDIRECT_404_RATE_LIMIT_MAX: '1000000',
    LOGIN_RATE_LIMIT_MAX: '1000',
    PUBLIC_PAGE_RATE_LIMIT_MAX: '1000000',
    EDIT_LINK_RATE_LIMIT_MAX: '1000000',
    EDIT_LINK_INVALID_RATE_LIMIT_MAX: '1000000',
    EDIT_LINK_SAVE_RATE_LIMIT_MAX: '1000000',
    COOKIE_SECURE: 'false',
    ...overrides,
  });
}

/** Clears all data and restarts the barcode code sequence. */
export async function resetDb(db) {
  await db.query(
    `TRUNCATE barcode_scans, scan_stats_daily, barcode_history, barcodes, import_batches, users, user_sessions
     RESTART IDENTITY CASCADE`,
  );
  await db.query('ALTER SEQUENCE barcode_code_seq RESTART WITH 1');
}

/**
 * A Google Maps resolver that cannot reach the network: long links resolve (that needs no request), short links fail
 * with the friendly error. Every test app gets this by default, so no test can ever contact Google by accident.
 */
export const offlineMaps = () =>
  createMapsResolver({
    fetch: async (url) => {
      throw new Error(`the tests must not use the network (asked for ${url})`);
    },
  });

/**
 * A made-up but well-formed Google Maps place: its long URL carries a location id, and placeId/reviewUrl are what the
 * system must derive from it. Different n, different place.
 */
export function mapsPlace(n = 1) {
  const high = 0x2e7a5919022e4800n + BigInt(n);
  const low = 0x40f12d5bc33d3f00n + BigInt(n);
  const placeId = buildPlaceId(high, low);
  return {
    placeId,
    reviewUrl: reviewUrlFor(placeId),
    url: `https://www.google.com/maps/place/Toko+Contoh+${n}/@-7.7381968,110.3834826,17z/data=!4m9!3m8!1s0x${high.toString(16)}:0x${low.toString(16)}!5m2!4m1!1i2!8m2!3d-7.738!4d110.383`,
    shortUrl: `https://maps.app.goo.gl/Contoh${n}`,
  };
}

/** Boots the whole application against the test database. `contextOverrides` replaces shared services (e.g. `maps`). */
export async function startApp(overrides = {}, contextOverrides = {}) {
  const config = testConfig(overrides);
  await migrateUp({ databaseUrl: config.db.url, ssl: config.db.ssl });
  const ctx = createContext(config, { maps: offlineMaps(), ...contextOverrides });
  const app = createApp(ctx);
  await resetDb(ctx.db);
  return {
    ctx,
    app,
    config,
    db: ctx.db,
    request: () => supertest(app),
    agent: () => supertest.agent(app),
    reset: () => resetDb(ctx.db),
    close: () => ctx.close(),
  };
}

export const extractCsrf = (html) => {
  const m = /name="_csrf" value="([^"]+)"/.exec(html) ?? /name="csrf-token" content="([^"]+)"/.exec(html);
  if (!m) throw new Error('CSRF token tidak ditemukan di halaman');
  return m[1];
};

export async function makeUser(ctx, { username = 'admin', email, password = PASSWORD, role = 'admin', name = 'Admin Uji' } = {}) {
  return createUser(ctx, { name, username, email: email ?? `${username}@contoh.test`, password, role });
}

/** A supertest agent (cookie jar) that is signed in through the real login form. */
export async function loginAgent(t, { identifier = 'admin', password = PASSWORD } = {}) {
  const agent = t.agent();
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: extractCsrf(page.text), identifier, password });
  if (res.status !== 302) throw new Error(`Login uji gagal: HTTP ${res.status}`);
  return agent;
}

/** Reads a fresh CSRF token from any admin page (tokens live in the session). */
export async function csrfFor(agent, page = '/admin/barcodes/new') {
  const res = await agent.get(page);
  return extractCsrf(res.text);
}

/** POST an urlencoded form with a valid CSRF token. */
export async function postForm(agent, url, fields = {}, { tokenPage = '/admin' } = {}) {
  const token = await csrfFor(agent, tokenPage);
  return agent.post(url).type('form').send({ _csrf: token, ...fields });
}

/**
 * Inserts barcodes directly (fast path for tests that are not about creation).
 * `targetUrl: null` creates a barcode that is still waiting for its destination. The codes follow CODE_MODE (sequential
 * in the tests: BR-000001, ...) unless `codeMode: 'random'` is given.
 */
export async function insertBarcodes(ctx, rows, createdBy = null, { codeMode } = {}) {
  const prepared = rows.map((r) => ({
    name: r.name ?? 'Barcode Uji',
    description: r.description ?? null,
    targetType: r.targetType ?? 'url',
    targetUrl: r.targetUrl === undefined ? 'https://example.com/tujuan' : r.targetUrl,
    mapsPlaceId: r.mapsPlaceId ?? null,
    mapsSourceUrl: r.mapsSourceUrl ?? null,
    status: r.status ?? 'active',
    expiredLocal: r.expiredLocal ?? null,
  }));
  return ctx.db.tx((tx) => barcodes.insertRows(tx, ctx.config, prepared, { createdBy, codeMode }));
}

/**
 * A card that waits for its owner, made the way the admin form makes one: no destination and a random code (a code that
 * cannot be guessed is what lets a scan open the activation page). Returns { code, token, link }.
 */
export async function waitingCard(app, fields = {}) {
  const [inserted] = await insertBarcodes(app.ctx, [{ name: 'Kartu Menunggu', targetUrl: null, ...fields }], null, { codeMode: 'random' });
  const token = await editTokenOf(app.ctx, inserted.code);
  return { code: inserted.code, token, link: `/e/${token}` };
}

/** The code a create form redirected to (`/admin/barcodes/BR-7K3M9QXT#link-edit`), or null. */
export const createdCode = (res) => /\/admin\/barcodes\/([A-Z0-9-]+)/.exec(res.headers.location ?? '')?.[1] ?? null;

/**
 * Somebody without an account: no cookies, only the edit link. The link opens the INFO page; the form is a second
 * page (`${link}/edit`), and that is also where it is submitted.
 */
export const linkHolder = (t) => ({
  open: (link) => t.request().get(link),
  form: (link) => t.request().get(`${link}/edit`),
  save: (link, fields) => t.request().post(`${link}/edit`).type('form').send(fields),
});

/**
 * A scripted stand-in for Google's short-link service: answers each short link from a table (value = the Location it
 * redirects to, an Error to throw, or a function returning a response) and records every request it was asked for.
 * Returns { calls, maps } where `maps` goes into startApp's context overrides.
 */
export function fakeGoogle(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const target = routes[url];
    if (!target) throw new Error(`unexpected request to ${url}`);
    if (target instanceof Error) throw target;
    if (typeof target === 'function') return target();
    return { status: 302, headers: new Headers({ location: target }), body: { cancel: async () => {} } };
  };
  return { calls, maps: createMapsResolver({ fetch: fetchImpl }) };
}

/** The secret of a barcode's edit link (read straight from the database; the app only shows it to admins). */
export async function editTokenOf(ctx, code) {
  return (await ctx.db.one('SELECT edit_token FROM barcodes WHERE code = $1', [code])).edit_token;
}

/** Performs a scan and waits until the (asynchronous) recording has finished. */
export async function scan(t, code, { ua, referer, ip, method = 'get' } = {}) {
  let req = t.request()[method](`/b/${code}`);
  if (ua !== undefined) req = req.set('User-Agent', ua);
  if (referer) req = req.set('Referer', referer);
  if (ip) req = req.set('X-Forwarded-For', ip);
  const res = await req;
  await t.ctx.recorder.idle();
  return res;
}

export const UA = {
  android: 'Mozilla/5.0 (Linux; Android 13; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  samsung: 'Mozilla/5.0 (Linux; Android 12; SAMSUNG SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  curl: 'curl/8.4.0',
};

/** superagent parser that keeps the raw bytes (it does not fill res.text for image/* types). */
export const binaryParser = (r, cb) => {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

/** GET a binary resource (PNG etc.) as a Buffer. */
export async function getBuffer(agent, url) {
  const res = await agent.get(url).buffer(true).parse(binaryParser);
  if (res.status !== 200) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.body;
}

/** Uploads a CSV through the real multipart form (with CSRF token). */
export async function uploadCsv(agent, content, { filename = 'data.csv', token, page = '/admin/import' } = {}) {
  const csrf = token ?? (await csrfFor(agent, page));
  return agent.post('/admin/import').field('_csrf', csrf).attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), filename);
}
