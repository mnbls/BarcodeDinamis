// Load-test data generator. Creates up to N barcodes (default 10.000) and, optionally, synthetic scans.
//
//   npm run data:generate                              -> add 10.000 barcodes
//   npm run data:generate -- --barcodes 10000 --scans 500000 --days 90
//   npm run data:generate -- --reset --barcodes 10000  -> delete ALL barcodes first (asks for --yes)
//
// Refuses to run in production unless --allow-production is passed.
import * as barcodes from '../src/modules/barcodes/barcodes.repo.js';
import { toLocalSql } from '../src/lib/dates.js';
import { bootstrap, parseArgs } from './lib/bootstrap.js';
import { insertSyntheticScans } from './lib/synthetic.js';

const args = parseArgs();
const count = Number.parseInt(args.barcodes ?? '10000', 10);
const scans = Number.parseInt(args.scans ?? '0', 10);
const days = Number.parseInt(args.days ?? '60', 10);
const CHUNK = 1000;

const CATEGORIES = ['Menu Meja', 'Brosur', 'Katalog Produk', 'Formulir', 'Poster', 'Kemasan', 'Kartu Nama', 'Spanduk', 'Tiket Acara', 'Label Aset'];
const PLACES = ['Yogyakarta', 'Semarang', 'Surabaya', 'Bandung', 'Jakarta Selatan', 'Malang', 'Solo', 'Denpasar', 'Medan', 'Makassar'];

const { config, ctx, db } = bootstrap();

try {
  if (config.isProd && !args['allow-production']) throw new Error('Generator ditolak di production (tambahkan --allow-production bila benar-benar disengaja).');
  if (!Number.isInteger(count) || count < 1 || count > 1_000_000) throw new Error('--barcodes harus 1 - 1.000.000');

  if (args.reset) {
    if (!args.yes) throw new Error('--reset MENGHAPUS SEMUA barcode. Tambahkan --yes untuk melanjutkan.');
    const res = await db.query('DELETE FROM barcodes');
    console.log(`${res.rowCount} barcode lama dihapus.`);
  }

  const admin = await db.one('SELECT id FROM users ORDER BY id LIMIT 1');
  const started = performance.now();
  const past = toLocalSql(new Date(Date.now() - 30 * 86_400_000), config.timezone);
  const future = toLocalSql(new Date(Date.now() + 200 * 86_400_000), config.timezone);
  const seq = (await db.one('SELECT count(*)::bigint AS n FROM barcodes')).n;

  for (let done = 0; done < count; done += CHUNK) {
    const size = Math.min(CHUNK, count - done);
    const rows = Array.from({ length: size }, (_, i) => {
      const n = seq + done + i + 1;
      const r = (n * 2654435761) % 100; // cheap deterministic spread
      return {
        name: `${CATEGORIES[n % CATEGORIES.length]} ${PLACES[(n >> 3) % PLACES.length]} #${String(n).padStart(5, '0')}`,
        description: n % 4 === 0 ? `Barcode uji beban nomor ${n}` : null,
        targetType: 'url',
        targetUrl: `https://example.com/uji/${CATEGORIES[n % CATEGORIES.length].toLowerCase().replace(/\s+/g, '-')}/${n}`,
        status: r < 6 ? 'inactive' : 'active',
        expiredLocal: r >= 6 && r < 9 ? past : r >= 9 && r < 30 ? future : null,
      };
    });
    await db.tx((tx) => barcodes.insertRows(tx, config, rows, { createdBy: admin?.id ?? null }));
    process.stdout.write(`\r${(done + size).toLocaleString('id-ID')} / ${count.toLocaleString('id-ID')} barcode`);
  }
  console.log(`\nSelesai membuat ${count.toLocaleString('id-ID')} barcode dalam ${((performance.now() - started) / 1000).toFixed(1)} detik.`);

  if (scans > 0) {
    const t = performance.now();
    const made = await insertSyntheticScans(db, config, { count: scans, days });
    console.log(`${Number(made).toLocaleString('id-ID')} scan sintetis dibuat dalam ${((performance.now() - t) / 1000).toFixed(1)} detik.`);
  }

  const total = await db.one('SELECT count(*)::bigint AS n, COALESCE(sum(scan_count), 0)::bigint AS s FROM barcodes');
  console.log(`Total sekarang: ${total.n.toLocaleString('id-ID')} barcode, ${total.s.toLocaleString('id-ID')} scan.`);
} catch (err) {
  console.error(`Gagal: ${err.message}`);
  process.exitCode = 1;
} finally {
  await ctx.db.end();
}
