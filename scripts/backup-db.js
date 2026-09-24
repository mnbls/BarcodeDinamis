// Database backup using pg_dump (custom format: compressed, restorable with pg_restore).
//
//   npm run db:backup                       -> storage/backups/barcode-YYYYMMDD-HHmmss.dump
//   npm run db:backup -- --out /mnt/backup --keep 30
//
// Restore:
//   pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" storage/backups/<file>.dump
//
// pg_dump is located through PG_DUMP_PATH, the PATH, or the standard PostgreSQL install folders.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { loadConfigFromEnvFile } from '../src/config/index.js';
import { parseArgs } from './lib/bootstrap.js';

function findPgDump() {
  if (process.env.PG_DUMP_PATH && existsSync(process.env.PG_DUMP_PATH)) return process.env.PG_DUMP_PATH;

  const probe = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'pg_dump';

  const roots = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((p) => path.join(p, 'PostgreSQL'))
    : ['/usr/lib/postgresql', '/usr/local/pgsql', '/opt/homebrew/opt'];
  const exe = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root).sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a));
    for (const v of versions) {
      const candidate = path.join(root, v, 'bin', exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const args = parseArgs();
try {
  const config = loadConfigFromEnvFile();
  const pgDump = findPgDump();
  if (!pgDump) throw new Error('pg_dump tidak ditemukan. Pasang PostgreSQL client tools atau isi PG_DUMP_PATH di .env.');

  const outDir = path.resolve(args.out || path.join(config.storageDir, 'backups'));
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `barcode-${stamp()}.dump`);

  const url = new URL(config.db.url);
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }; // never on the command line
  const dumpArgs = [
    '--format=custom', '--no-owner', '--no-privileges',
    '--host', url.hostname, '--port', url.port || '5432', '--username', decodeURIComponent(url.username),
    '--file', file, decodeURIComponent(url.pathname.replace(/^\//, '')),
  ];
  if (config.db.ssl) env.PGSSLMODE = 'require';

  await new Promise((resolve, reject) => {
    const child = spawn(pgDump, dumpArgs, { env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump berhenti dengan kode ${code}`))));
  });

  const kb = Math.round(statSync(file).size / 1024);
  console.log(`[db:backup] Selesai: ${file} (${kb.toLocaleString('id-ID')} KB)`);

  // Retention: keep the newest N backups produced by this script.
  const keep = Number.parseInt(args.keep ?? process.env.BACKUP_KEEP ?? '14', 10);
  if (Number.isInteger(keep) && keep > 0) {
    const old = readdirSync(outDir).filter((f) => /^barcode-\d{8}-\d{6}\.dump$/.test(f)).sort().reverse().slice(keep);
    for (const f of old) {
      unlinkSync(path.join(outDir, f));
      console.log(`[db:backup] Backup lama dihapus: ${f}`);
    }
  }
} catch (err) {
  console.error(`[db:backup] ${err.message}`);
  process.exitCode = 1;
}
