// Creates the PostgreSQL role and database named in DATABASE_URL (run once, on a fresh server).
//
//   ADMIN_DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/postgres npm run db:create
//   npm run db:create -- --admin-url postgres://postgres:PASSWORD@localhost:5432/postgres
//
// The admin (superuser) URL is only used here and is never stored. Prefer the environment variable:
// command-line arguments are visible to other users of the machine.
import dotenv from 'dotenv';
import path from 'node:path';
import pg from 'pg';
import { parseArgs } from './lib/bootstrap.js';

dotenv.config({ path: process.env.ENV_FILE || path.resolve(import.meta.dirname, '..', '.env'), quiet: true });

const args = parseArgs();
const adminUrl = args['admin-url'] || process.env.ADMIN_DATABASE_URL;
const targetUrl = process.env.DATABASE_URL;

function fail(message) {
  console.error(`[db:create] ${message}`);
  process.exit(1);
}

if (!targetUrl) fail('DATABASE_URL belum diisi di .env.');
if (!adminUrl) {
  fail('Butuh URL superuser PostgreSQL, mis.:\n  ADMIN_DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/postgres npm run db:create');
}

const target = new URL(targetUrl);
const role = decodeURIComponent(target.username);
const password = decodeURIComponent(target.password);
const database = decodeURIComponent(target.pathname.replace(/^\//, ''));
if (!role || !password || !database) fail('DATABASE_URL harus berbentuk postgres://user:password@host:port/database');

const admin = new pg.Client({ connectionString: adminUrl });
try {
  await admin.connect();
} catch (err) {
  fail(`Tidak dapat terhubung dengan URL superuser: ${err.message}`);
}

const id = (name) => admin.escapeIdentifier(name);
const lit = (value) => admin.escapeLiteral(value);

try {
  const roleExists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;
  if (roleExists) console.log(`[db:create] Role "${role}" sudah ada, dilewati (password tidak diubah).`);
  else {
    await admin.query(`CREATE ROLE ${id(role)} LOGIN PASSWORD ${lit(password)}`);
    console.log(`[db:create] Role "${role}" dibuat.`);
  }

  const dbExists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount > 0;
  if (dbExists) console.log(`[db:create] Database "${database}" sudah ada, dilewati.`);
  else {
    try {
      await admin.query(`CREATE DATABASE ${id(database)} OWNER ${id(role)} ENCODING 'UTF8' TEMPLATE template0`);
    } catch (err) {
      // Some Windows installations use a non-UTF8 locale, which forbids the explicit UTF8 request.
      console.warn(`[db:create] Pembuatan dengan ENCODING UTF8 gagal (${err.message}); mencoba pengaturan bawaan server.`);
      await admin.query(`CREATE DATABASE ${id(database)} OWNER ${id(role)}`);
    }
    console.log(`[db:create] Database "${database}" dibuat (pemilik: ${role}).`);
  }
  await admin.end();

  // Optional extension for fast ILIKE searches; needs a superuser, so it is done here.
  const inDb = new pg.Client({ connectionString: adminUrl.replace(/\/[^/?]*(\?|$)/, `/${encodeURIComponent(database)}$1`) });
  await inDb.connect();
  try {
    await inDb.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    console.log('[db:create] Ekstensi pg_trgm aktif (pencarian cepat).');
  } catch (err) {
    console.warn(`[db:create] pg_trgm dilewati: ${err.message}. Aplikasi tetap berjalan, hanya pencarian tanpa index trigram.`);
  } finally {
    await inDb.end();
  }

  console.log('\nSelesai. Langkah berikutnya:\n  npm run migrate\n  npm run seed        (atau: npm run admin:create)');
} catch (err) {
  await admin.end().catch(() => {});
  fail(err.message);
}
