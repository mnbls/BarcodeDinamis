// Usage:
//   npm run migrate            -> apply pending migrations
//   npm run migrate:status     -> show applied / pending migrations
//   npm run db:reset           -> DEV ONLY: drop everything and re-apply (needs --yes)
import { loadConfigFromEnvFile } from '../src/config/index.js';
import { migrateFresh, migrateUp, migrationStatus } from '../src/db/migrate.js';

const command = process.argv[2] || 'up';
const flags = new Set(process.argv.slice(3));
const log = (msg) => console.log(`[migrate] ${msg}`);

try {
  const config = loadConfigFromEnvFile();
  const opts = { databaseUrl: config.db.url, ssl: config.db.ssl, log };

  if (command === 'up') {
    const applied = await migrateUp(opts);
    log(applied.length ? `Selesai. ${applied.length} migration dijalankan.` : 'Database sudah up-to-date.');
  } else if (command === 'status') {
    const rows = await migrationStatus(opts);
    for (const r of rows) console.log(`${r.appliedAt ? 'applied ' : 'PENDING '} ${r.name}${r.appliedAt ? `  (${r.appliedAt.toISOString()})` : ''}`);
  } else if (command === 'fresh') {
    if (config.isProd) throw new Error('db:reset ditolak di production.');
    if (!flags.has('--yes')) {
      throw new Error('db:reset MENGHAPUS SEMUA DATA. Jalankan ulang dengan: npm run db:reset -- --yes');
    }
    const applied = await migrateFresh(opts);
    log(`Database di-reset. ${applied.length} migration dijalankan.`);
  } else {
    throw new Error(`Perintah tidak dikenal: ${command}. Gunakan up | status | fresh`);
  }
} catch (err) {
  console.error(`[migrate] ${err.message}`);
  process.exitCode = 1;
}
