import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PASSWORD, extractCsrf, insertBarcodes, loginAgent, makeUser, mapsPlace, startApp, testConfig } from '../helpers/app.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Runs one of the project's CLI scripts against the TEST database, exactly as an operator would. */
function run(script, args = [], env = {}) {
  const config = testConfig();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('scripts', script), ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ENV_FILE: path.join(ROOT, 'does-not-exist.env'),
        DATABASE_URL: config.db.url,
        APP_URL: 'https://barcode.test',
        SESSION_SECRET: 'x'.repeat(48),
        BCRYPT_ROUNDS: '4',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('command line tools', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());
  beforeEach(async () => {
    await t.reset();
  });

  const canLogin = async (identifier, password) => {
    const agent = t.agent();
    const page = await agent.get('/login');
    const res = await agent.post('/login').type('form').send({ _csrf: extractCsrf(page.text), identifier, password });
    return res.status === 302;
  };

  it('admin:create makes an account that can log in, with a hashed password and the requested role', async () => {
    const res = await run('create-admin.js', ['--name', 'Rina Kurnia', '--username', 'rina', '--email', 'rina@contoh.co.id', '--role', 'viewer'], { ADMIN_PASSWORD: 'Rahasia-Bagus-88' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Akun viewer "rina" berhasil dibuat/);
    assert.ok(!res.stdout.includes('Rahasia-Bagus-88'), 'the password is never echoed');
    const row = await t.db.one("SELECT name, role, password_hash FROM users WHERE username = 'rina'");
    assert.deepEqual([row.name, row.role], ['Rina Kurnia', 'viewer']);
    assert.match(row.password_hash, /^\$2[aby]\$/);
    assert.equal(await canLogin('rina', 'Rahasia-Bagus-88'), true);
    assert.equal(await canLogin('rina', 'salah-password-1'), false);
  });

  it('admin:create refuses weak passwords, bad usernames and duplicates', async () => {
    const base = ['--name', 'X', '--email', 'x@contoh.co.id', '--role', 'admin'];
    let res = await run('create-admin.js', ['--username', 'xx1', ...base], { ADMIN_PASSWORD: 'pendek' });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /minimal 8 karakter/);
    res = await run('create-admin.js', ['--username', 'bad name!', ...base], { ADMIN_PASSWORD: 'Cukup-Panjang-9' });
    assert.match(res.stderr, /Username 3-50 karakter/);
    res = await run('create-admin.js', ['--username', 'dua', '--name', 'D', '--email', 'd@contoh.co.id', '--role', 'superuser'], { ADMIN_PASSWORD: 'Cukup-Panjang-9' });
    assert.match(res.stderr, /Role harus admin atau viewer/);
    assert.equal((await run('create-admin.js', ['--username', 'dua', ...base], { ADMIN_PASSWORD: 'Cukup-Panjang-9' })).code, 0);
    res = await run('create-admin.js', ['--username', 'dua', ...base], { ADMIN_PASSWORD: 'Cukup-Panjang-9' });
    assert.match(res.stderr, /sudah terdaftar/);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM users')).n, 1);
  });

  it('admin:reset sets a new password and ends every open session of that account', async () => {
    await makeUser(t.ctx, { username: 'admin' });
    const session = await loginAgent(t);
    assert.equal((await session.get('/admin')).status, 200);

    let res = await run('reset-password.js', ['--username', 'nobody'], { ADMIN_PASSWORD: 'Baru-Password-77' });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /tidak ditemukan/);
    res = await run('reset-password.js', ['--username', 'admin'], { ADMIN_PASSWORD: 'lemah' });
    assert.match(res.stderr, /minimal 8 karakter/);
    assert.equal((await session.get('/admin')).status, 200, 'a rejected reset changes nothing');

    res = await run('reset-password.js', ['--username', 'admin'], { ADMIN_PASSWORD: 'Baru-Password-77' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Password "admin" diganti/);
    assert.equal((await session.get('/admin')).status, 302, 'the old session is gone');
    assert.equal(await canLogin('admin', PASSWORD), false);
    assert.equal(await canLogin('admin', 'Baru-Password-77'), true);
  });

  it('migrate is idempotent and reports its status', async () => {
    const status = await run('migrate.js', ['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /applied\s+0001_init\.sql/);
    const again = await run('migrate.js', ['up']);
    assert.match(again.stdout, /sudah up-to-date/);
    const refuse = await run('migrate.js', ['fresh']);
    assert.notEqual(refuse.code, 0);
    assert.match(refuse.stderr, /--yes/, 'destructive reset needs an explicit flag');
    const production = await run('migrate.js', ['fresh', '--yes'], { NODE_ENV: 'production' });
    assert.match(production.stderr, /ditolak di production/);
  });

  it('seed creates the admin plus 20-50 dummy barcodes with consistent statistics, and never duplicates on a second run', async () => {
    const res = await run('seed.js', [], { SEED_ADMIN_USERNAME: 'admin', SEED_ADMIN_EMAIL: 'admin@contoh.test', SEED_ADMIN_PASSWORD: 'Seed-Password-55' });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Seed selesai/);

    const stats = await t.db.one(`SELECT
        (SELECT count(*) FROM users)::int AS users,
        (SELECT count(*) FROM barcodes)::int AS barcodes,
        (SELECT count(*) FILTER (WHERE status = 'inactive') FROM barcodes)::int AS inactive,
        (SELECT count(*) FILTER (WHERE expired_at < now()) FROM barcodes)::int AS expired,
        (SELECT count(DISTINCT code) FROM barcodes)::int AS codes,
        (SELECT count(*) FROM barcode_scans)::int AS raw,
        (SELECT COALESCE(sum(scans), 0) FROM scan_stats_daily)::int AS rolled,
        (SELECT COALESCE(sum(scan_count), 0) FROM barcodes)::int AS counters,
        (SELECT count(*) FROM barcode_history)::int AS history`);
    assert.equal(stats.users, 1);
    assert.ok(stats.barcodes >= 20 && stats.barcodes <= 50, `${stats.barcodes} demo barcodes`);
    assert.equal(stats.codes, stats.barcodes);
    assert.ok(stats.inactive >= 1 && stats.expired >= 1, 'the demo set contains inactive and expired barcodes');
    assert.ok(stats.raw > 500);
    assert.equal(stats.rolled, stats.raw, 'rollup equals the raw log');
    assert.equal(stats.counters, stats.raw, 'counters equal the raw log');
    assert.ok(stats.history >= 3, 'some barcodes have an edit history');
    assert.equal(await canLogin('admin', 'Seed-Password-55'), true);

    const second = await run('seed.js', [], { SEED_ADMIN_PASSWORD: 'Seed-Password-55' });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /sudah ada/);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, stats.barcodes, 'no duplicate demo data');
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM users')).n, 1);
  });

  it('seed prints a random password once when none is configured, and never a weak one in production', async () => {
    const res = await run('seed.js', ['--no-demo'], { SEED_ADMIN_PASSWORD: '' });
    assert.equal(res.code, 0, res.stderr);
    const generated = /PASSWORD \(hanya ditampilkan sekali\): (\S+)/.exec(res.stdout)?.[1];
    assert.ok(generated && generated.length >= 16, 'a strong random password is generated');
    assert.equal(await canLogin('admin', generated), true);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 0, '--no-demo');

    await t.reset();
    const weak = await run('seed.js', [], { NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(48), SEED_ADMIN_PASSWORD: 'admin123456' });
    assert.notEqual(weak.code, 0);
    assert.match(weak.stderr, /terlalu lemah untuk production/);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM users')).n, 0);
  });

  it('data:generate creates barcodes (and synthetic scans) in bulk, refuses production, and --reset needs --yes', async () => {
    await makeUser(t.ctx, { username: 'admin' });
    let res = await run('generate-data.js', ['--barcodes', '1500', '--scans', '4000', '--days', '30']);
    assert.equal(res.code, 0, res.stderr);
    const stats = await t.db.one(`SELECT count(*)::int AS n, count(DISTINCT code)::int AS codes, min(code) AS lo, max(code) AS hi,
        (SELECT count(*) FROM barcode_scans)::int AS raw, (SELECT COALESCE(sum(scan_count), 0) FROM barcodes)::int AS counters FROM barcodes`);
    assert.deepEqual([stats.n, stats.codes, stats.lo, stats.hi], [1500, 1500, 'BR-000001', 'BR-001500']);
    assert.equal(stats.counters, stats.raw);
    assert.ok(stats.raw >= 4000);

    res = await run('generate-data.js', ['--barcodes', '10', '--reset']);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /--yes/);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 1500, 'nothing was deleted');

    res = await run('generate-data.js', ['--barcodes', '10'], { NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(48) });
    assert.match(res.stderr, /ditolak di production/);

    res = await run('generate-data.js', ['--barcodes', '20', '--reset', '--yes']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal((await t.db.one('SELECT count(*)::int AS n FROM barcodes')).n, 20);
  });

  it('maps:rebuild derives the review address from the Place ID again: a dry run first, then --yes, and only for Maps barcodes', async () => {
    const [current, stale] = [mapsPlace(1), mapsPlace(2)];
    const old = 'https://old-format.example/review?id=';
    await insertBarcodes(t.ctx, [
      { name: 'Sudah sesuai', targetType: 'maps_review', targetUrl: current.reviewUrl, mapsPlaceId: current.placeId, mapsSourceUrl: current.url },
      { name: 'Format lama', targetType: 'maps_review', targetUrl: `${old}${stale.placeId}`, mapsPlaceId: stale.placeId, mapsSourceUrl: stale.url },
      { name: 'Website biasa', targetUrl: 'https://contoh.com/situs' },
      { name: 'Belum diisi', targetType: 'maps_review', targetUrl: null },
    ]);
    const urls = async () => (await t.db.rows('SELECT code, target_url FROM barcodes ORDER BY id')).map((r) => r.target_url);
    const before = await urls();

    let res = await run('rebuild-review-urls.js');
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /2 barcode Ulasan Google Maps, 1 perlu diperbarui/);
    assert.ok(res.stdout.includes(stale.reviewUrl), 'shows what the address will become');
    assert.match(res.stdout, /Tidak ada yang diubah/);
    assert.deepEqual(await urls(), before, 'a dry run writes nothing');

    res = await run('rebuild-review-urls.js', ['--yes']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /1 barcode diperbarui/);
    assert.deepEqual(await urls(), [current.reviewUrl, stale.reviewUrl, 'https://contoh.com/situs', null], 'only the outdated Maps barcode changed');
    assert.equal((await t.db.one("SELECT maps_place_id FROM barcodes WHERE name = 'Format lama'")).maps_place_id, stale.placeId, 'the Place ID is untouched: it is the source of truth');

    res = await run('rebuild-review-urls.js', ['--yes']);
    assert.match(res.stdout, /Semua sudah sesuai format terbaru/);
  });
});
