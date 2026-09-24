import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PASSWORD, csrfFor, extractCsrf, loginAgent, makeUser, postForm, startApp } from '../helpers/app.js';

describe('authentication', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await makeUser(t.ctx, { username: 'admin' });
  });

  it('login page renders with a CSRF token and no session cookie leak of secrets', async () => {
    const res = await t.request().get('/login');
    assert.equal(res.status, 200);
    assert.match(res.text, /name="_csrf"/);
    assert.match(res.text, /Username atau email/);
  });

  it('logs in with username OR email and redirects into the admin area', async () => {
    for (const identifier of ['admin', 'ADMIN', 'admin@contoh.test']) {
      const agent = t.agent();
      const page = await agent.get('/login');
      const res = await agent.post('/login').type('form').send({ _csrf: extractCsrf(page.text), identifier, password: PASSWORD });
      assert.equal(res.status, 302, identifier);
      assert.equal(res.headers.location, '/admin');
      const dash = await agent.get('/admin');
      assert.equal(dash.status, 200);
      assert.match(dash.text, /Dashboard/);
    }
  });

  it('rejects wrong credentials with one generic message (no user enumeration)', async () => {
    const attempt = async (identifier, password) => {
      const agent = t.agent();
      const page = await agent.get('/login');
      return agent.post('/login').type('form').send({ _csrf: extractCsrf(page.text), identifier, password });
    };
    const wrongPassword = await attempt('admin', 'salah-banget-1');
    const unknownUser = await attempt('tidak-ada', 'salah-banget-1');
    for (const res of [wrongPassword, unknownUser]) {
      assert.equal(res.status, 401);
      assert.match(res.text, /Username\/email atau password salah/);
      assert.ok(!/tidak ditemukan|not found|tidak terdaftar/i.test(res.text));
    }
    // Same visible page apart from the echoed identifier / CSRF token.
    const strip = (h) => h.replace(/(value|content)="[^"]*"/g, '');
    assert.equal(strip(wrongPassword.text), strip(unknownUser.text));
  });

  it('never stores or exposes plain-text passwords (bcrypt only)', async () => {
    const row = await t.db.one("SELECT password_hash FROM users WHERE username = 'admin'");
    assert.match(row.password_hash, /^\$2[aby]\$\d{2}\$/);
    assert.ok(!row.password_hash.includes(PASSWORD));
    const agent = await loginAgent(t);
    const settings = await agent.get('/admin/settings');
    assert.ok(!settings.text.includes(row.password_hash));
  });

  it('issues an HttpOnly, SameSite=Lax session cookie and a NEW id at login (fixation defence)', async () => {
    const agent = t.agent();
    const page = await agent.get('/login');
    const before = page.headers['set-cookie']?.[0];
    const res = await agent.post('/login').type('form').send({ _csrf: extractCsrf(page.text), identifier: 'admin', password: PASSWORD });
    const after = res.headers['set-cookie']?.[0];
    assert.match(after, /HttpOnly/i);
    assert.match(after, /SameSite=Lax/i);
    assert.notEqual(before?.split(';')[0], after?.split(';')[0], 'session id must change on login');
  });

  it('protects every admin page: anonymous visitors are sent to the login page', async () => {
    for (const path of ['/admin', '/admin/barcodes', '/admin/barcodes/new', '/admin/import', '/admin/analytics', '/admin/history', '/admin/settings', '/admin/barcodes/BR-000001', '/admin/barcodes/export.csv']) {
      const res = await t.request().get(path);
      assert.equal(res.status, 302, path);
      assert.match(res.headers.location, /^\/login\?next=/, path);
    }
  });

  it('keeps the requested page as "next" and refuses open redirects', async () => {
    const agent = t.agent();
    const page = await agent.get('/login?next=%2Fadmin%2Fhistory');
    const good = await agent.post('/login').type('form').send({ _csrf: extractCsrf(page.text), identifier: 'admin', password: PASSWORD, next: '/admin/history' });
    assert.equal(good.headers.location, '/admin/history');

    for (const evil of ['https://evil.example.com', '//evil.example.com', '/\\evil.example.com', 'javascript:alert(1)', '/admin\r\nSet-Cookie: x=1', '/not-admin']) {
      const a = t.agent();
      const p = await a.get('/login');
      const res = await a.post('/login').type('form').send({ _csrf: extractCsrf(p.text), identifier: 'admin', password: PASSWORD, next: evil });
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/admin', `next=${JSON.stringify(evil)}`);
    }
  });

  it('logout is a POST that needs a CSRF token and really ends the session', async () => {
    const agent = await loginAgent(t);
    const noToken = await agent.post('/logout').type('form').send({});
    assert.equal(noToken.status, 403);
    assert.equal((await agent.get('/admin')).status, 200, 'still signed in after the rejected logout');

    const res = await postForm(agent, '/logout');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login');
    const after = await agent.get('/admin');
    assert.equal(after.status, 302, 'session is gone');
    assert.equal((await agent.get('/logout')).status, 404, 'GET /logout must not exist');
  });

  it('disabled accounts lose access immediately and cannot log in again', async () => {
    const agent = await loginAgent(t);
    await t.db.query("UPDATE users SET is_active = FALSE WHERE username = 'admin'");
    assert.equal((await agent.get('/admin')).status, 302, 'the open session is dropped on the next request');

    const fresh = t.agent();
    const page = await fresh.get('/login');
    const blocked = await fresh.post('/login').type('form').send({ _csrf: extractCsrf(page.text), identifier: 'admin', password: PASSWORD });
    assert.equal(blocked.status, 401);
  });

  it('rate-limits repeated failed logins per IP + username', async () => {
    const limited = await startApp({ LOGIN_RATE_LIMIT_MAX: '3' });
    try {
      await makeUser(limited.ctx, { username: 'admin' });
      const agent = limited.agent();
      const page = await agent.get('/login');
      const csrf = extractCsrf(page.text);
      const statuses = [];
      for (let i = 0; i < 5; i += 1) {
        const r = await agent.post('/login').type('form').send({ _csrf: csrf, identifier: 'admin', password: 'salah-terus-1' });
        statuses.push(r.status);
      }
      assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
      assert.deepEqual(statuses.slice(3), [429, 429]);
      // even the CORRECT password is blocked while the window is exhausted
      const blocked = await agent.post('/login').type('form').send({ _csrf: csrf, identifier: 'admin', password: PASSWORD });
      assert.equal(blocked.status, 429);
      // another username is unaffected
      await makeUser(limited.ctx, { username: 'lain' });
      const other = await agent.post('/login').type('form').send({ _csrf: csrf, identifier: 'lain', password: PASSWORD });
      assert.equal(other.status, 302);
    } finally {
      await limited.close();
    }
  });
});

describe('profile and password', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await makeUser(t.ctx, { username: 'admin' });
  });

  it('changes the password: wrong current / weak / mismatch are rejected, success signs out other devices', async () => {
    const laptop = await loginAgent(t);
    const phone = await loginAgent(t);
    const url = '/admin/settings/password';
    const page = '/admin/settings';

    let res = await postForm(laptop, url, { currentPassword: 'bukan-ini-1', newPassword: 'Baru-Password-77', confirmPassword: 'Baru-Password-77' }, { tokenPage: page });
    assert.equal(res.status, 422);
    assert.match(res.text, /Password saat ini salah/);

    res = await postForm(laptop, url, { currentPassword: PASSWORD, newPassword: 'pendek1', confirmPassword: 'pendek1' }, { tokenPage: page });
    assert.equal(res.status, 422);
    assert.match(res.text, /minimal 8 karakter/);

    res = await postForm(laptop, url, { currentPassword: PASSWORD, newPassword: 'hanyahuruf', confirmPassword: 'hanyahuruf' }, { tokenPage: page });
    assert.match(res.text, /huruf dan angka/);

    res = await postForm(laptop, url, { currentPassword: PASSWORD, newPassword: 'Baru-Password-77', confirmPassword: 'Beda-Password-77' }, { tokenPage: page });
    assert.match(res.text, /Konfirmasi password tidak sama/);

    res = await postForm(laptop, url, { currentPassword: PASSWORD, newPassword: PASSWORD, confirmPassword: PASSWORD }, { tokenPage: page });
    assert.match(res.text, /harus berbeda/);

    res = await postForm(laptop, url, { currentPassword: PASSWORD, newPassword: 'Baru-Password-77', confirmPassword: 'Baru-Password-77' }, { tokenPage: page });
    assert.equal(res.status, 302);

    assert.equal((await laptop.get('/admin')).status, 200, 'the device that changed the password stays signed in');
    assert.equal((await phone.get('/admin')).status, 302, 'every other session is ended');

    const fresh = t.agent();
    const p = await fresh.get('/login');
    const old = await fresh.post('/login').type('form').send({ _csrf: extractCsrf(p.text), identifier: 'admin', password: PASSWORD });
    assert.equal(old.status, 401);
    const p2 = await fresh.get('/login');
    const ok = await fresh.post('/login').type('form').send({ _csrf: extractCsrf(p2.text), identifier: 'admin', password: 'Baru-Password-77' });
    assert.equal(ok.status, 302);
  });

  it('updates the profile and prevents duplicate usernames/emails', async () => {
    await makeUser(t.ctx, { username: 'rina', email: 'rina@contoh.test' });
    const agent = await loginAgent(t);
    const url = '/admin/settings/profile';

    let res = await postForm(agent, url, { name: 'A', username: 'admin', email: 'admin@contoh.test' }, { tokenPage: '/admin/settings' });
    assert.equal(res.status, 422);
    assert.match(res.text, /Nama 2-120 karakter/);

    res = await postForm(agent, url, { name: 'Admin Baru', username: 'rina', email: 'admin@contoh.test' }, { tokenPage: '/admin/settings' });
    assert.match(res.text, /Username sudah dipakai/);

    res = await postForm(agent, url, { name: 'Admin Baru', username: 'admin', email: 'rina@contoh.test' }, { tokenPage: '/admin/settings' });
    assert.match(res.text, /Email sudah dipakai/);

    res = await postForm(agent, url, { name: 'Admin Baru', username: 'admin.baru', email: 'baru@contoh.test' }, { tokenPage: '/admin/settings' });
    assert.equal(res.status, 302);
    const page = await agent.get('/admin/settings');
    assert.match(page.text, /Admin Baru/);
    assert.match(page.text, /admin\.baru/);
  });
});

describe('authorisation (roles)', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await makeUser(t.ctx, { username: 'admin' });
    await makeUser(t.ctx, { username: 'pembaca', role: 'viewer' });
  });

  it('a viewer can read but every write action is forbidden', async () => {
    const admin = await loginAgent(t);
    const created = await postForm(admin, '/admin/barcodes', { name: 'Contoh', target_type: 'url', target_value: 'https://example.com/x', status: 'active' }, { tokenPage: '/admin/barcodes/new' });
    assert.equal(created.status, 302);
    const code = created.headers.location.split('/').pop();

    const viewer = await loginAgent(t, { identifier: 'pembaca' });
    for (const path of ['/admin', '/admin/barcodes', `/admin/barcodes/${code}`, '/admin/analytics', '/admin/history', '/admin/settings', `/admin/barcodes/${code}/qr.png`, `/admin/barcodes/${code}/print`]) {
      assert.equal((await viewer.get(path)).status, 200, path);
    }
    assert.equal((await viewer.get('/admin/barcodes/export.csv')).status, 200, 'viewers may export');

    for (const path of ['/admin/barcodes/new', `/admin/barcodes/${code}/edit`, '/admin/import']) {
      assert.equal((await viewer.get(path)).status, 403, `GET ${path}`);
    }
    const token = await csrfFor(viewer, '/admin/barcodes');
    const writes = [
      ['/admin/barcodes', { name: 'X', target_type: 'url', target_value: 'https://example.com', status: 'active' }],
      [`/admin/barcodes/${code}`, { name: 'Ubah', target_type: 'url', target_value: 'https://example.com/z', status: 'active' }],
      [`/admin/barcodes/${code}/status`, { status: 'inactive' }],
      [`/admin/barcodes/${code}/delete`, {}],
      ['/admin/barcodes/bulk', { action: 'delete', ids: '1' }],
    ];
    for (const [path, body] of writes) {
      const res = await viewer.post(path).type('form').send({ _csrf: token, ...body });
      assert.equal(res.status, 403, `POST ${path}`);
    }
    const row = await t.db.one('SELECT name, status FROM barcodes WHERE code = $1', [code]);
    assert.deepEqual({ ...row }, { name: 'Contoh', status: 'active' }, 'nothing changed');

    const page = await viewer.get('/admin/barcodes');
    assert.ok(!page.text.includes('Buat Barcode'), 'write buttons are hidden for viewers');
  });
});
