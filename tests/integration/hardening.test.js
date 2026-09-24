import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PASSWORD, extractCsrf, loginAgent, makeUser, startApp } from '../helpers/app.js';

const HOUR = 3600;

// user_sessions.expire is a timestamp WITHOUT time zone, stored in the database's zone: compare it with the
// database's own "now" so the answer does not depend on either time zone.
const SECONDS_LEFT = "extract(epoch FROM (expire - (now() AT TIME ZONE current_setting('TimeZone'))))";

describe('session table hygiene', () => {
  let t;
  before(async () => {
    t = await startApp({ SESSION_TTL_HOURS: '8' });
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await makeUser(t.ctx, { username: 'admin' });
  });

  it('a visitor who only opened the login page gets a 1-hour session; a signed-in admin gets the full 8 hours', async () => {
    await t.request().get('/login');
    const anonymous = await t.db.one(`SELECT ${SECONDS_LEFT} AS secs FROM user_sessions`);
    assert.ok(anonymous.secs > 0.8 * HOUR && anonymous.secs <= 1.02 * HOUR, `anonymous session lives ~1h, got ${Math.round(anonymous.secs / 60)} min`);

    const agent = await loginAgent(t);
    await agent.get('/admin');
    const signedIn = await t.db.one(`SELECT ${SECONDS_LEFT} AS secs FROM user_sessions WHERE sess->>'userId' IS NOT NULL`);
    assert.ok(signedIn.secs > 7.8 * HOUR && signedIn.secs <= 8.02 * HOUR, `admin session lives ~8h, got ${(signedIn.secs / HOUR).toFixed(2)} h`);
  });

  it('logging in does not carry the short anonymous lifetime over to the new session cookie', async () => {
    const agent = t.agent();
    const page = await agent.get('/login');
    const res = await agent.post('/login').type('form').send({ _csrf: extractCsrf(page.text), identifier: 'admin', password: PASSWORD });
    assert.equal(res.status, 302);
    const cookie = res.headers['set-cookie'][0];
    const expires = new Date(/Expires=([^;]+)/.exec(cookie)[1]).getTime();
    assert.ok(expires - Date.now() > 7.5 * HOUR * 1000, 'cookie lives about 8 hours');
  });

  it('pages without a form (landing, redirect pages, assets) never create session rows', async () => {
    for (const path of ['/', '/robots.txt', '/healthz', '/favicon.ico', '/assets/css/base.css', '/b/BR-999999', '/nonexistent']) await t.request().get(path);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM user_sessions')).n, 0);
  });

  it('throttles the login page per IP so crawlers cannot flood the session table', async () => {
    const limited = await startApp({ PUBLIC_PAGE_RATE_LIMIT_MAX: '3' });
    try {
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await limited.request().get('/login')).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      assert.equal((await limited.db.one('SELECT count(*)::int AS n FROM user_sessions')).n, 3, 'the throttled requests created nothing');
      assert.match((await limited.request().get('/login')).text, /Terlalu Banyak Permintaan/);
    } finally {
      await limited.close();
    }
  });
});
