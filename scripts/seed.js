// Seeds the database.
//
//   npm run seed                 -> admin account (+ 30 demo barcodes with sample scans, outside production)
//   npm run seed -- --demo       -> force demo data even in production
//   npm run seed -- --no-demo    -> admin account only
//
// The admin comes from SEED_ADMIN_* in .env. With an empty SEED_ADMIN_PASSWORD a random password is
// generated and printed ONCE. Running the seed twice never duplicates anything.
import { randomBytes } from 'node:crypto';
import { createUser } from '../src/modules/auth/auth.service.js';
import * as barcodes from '../src/modules/barcodes/barcodes.repo.js';
import { bootstrap, parseArgs } from './lib/bootstrap.js';
import { insertSyntheticScans } from './lib/synthetic.js';

const args = parseArgs();
const { config, ctx, db } = bootstrap();

// [name, description, target type, target url, status, expiry (local time) or null]
const DEMO = [
  ['Menu Digital Warung Sate Pak Slamet', 'Stiker di meja pelanggan', 'url', 'https://example.com/menu/warung-sate-pak-slamet', 'active'],
  ['Katalog Batik Semarang 2026', 'Brosur pameran UMKM', 'url', 'https://example.com/katalog/batik-semarang-2026', 'active'],
  ['Pendaftaran Seminar Nasional Teknologi Pertanian', 'Poster di gedung fakultas', 'url', 'https://example.org/seminar/teknologi-pertanian-2026', 'active'],
  ['Survei Kepuasan Kantin Fakultas Teknik', 'Stiker di kantin', 'url', 'https://example.org/survei/kantin-ft', 'active'],
  ['Presensi Kuliah Umum Kewirausahaan', 'Layar di ruang kuliah', 'url', 'https://example.org/presensi/kuliah-umum', 'active'],
  ['Denah Lokasi Ekspo UMKM Yogyakarta', 'Papan informasi pintu masuk', 'url', 'https://example.com/ekspo/denah', 'active'],
  ['Profil Kopi Tepi Sawah', 'Kemasan biji kopi 250 gram', 'url', 'https://example.com/kopi-tepi-sawah', 'active'],
  ['Formulir Pemesanan Nasi Box', 'Kartu nama katering', 'url', 'https://example.com/pesan/nasi-box', 'active'],
  ['Panduan Mesin Penggiling Kopi G-200', 'Label di badan mesin', 'url', 'https://example.com/manual/g-200', 'active'],
  ['Jadwal Kereta Wisata Lokal', 'Papan di stasiun', 'url', 'https://example.com/jadwal/kereta-wisata', 'active'],
  ['Pembayaran Parkir Area Pasar', 'Portal parkir', 'url', 'https://example.com/bayar/parkir-pasar', 'active'],
  ['Katalog Tanaman Hias Nursery Hijau', 'Brosur nursery', 'url', 'https://example.com/nursery-hijau/katalog', 'active'],
  ['Chat WhatsApp Toko Bunga Melati', 'Spanduk depan toko', 'whatsapp', 'https://wa.me/6281200001234?text=Halo%2C%20saya%20ingin%20memesan%20bunga', 'active'],
  ['Email Layanan Pelanggan', 'Kartu garansi', 'email', 'mailto:layanan@example.com?subject=Bantuan%20pesanan', 'active'],
  ['Telepon Klinik Sehat Sentosa', 'Kartu pasien', 'phone', 'tel:+62274123456', 'active'],
  ['Resep Rendang Ibu Ratna', 'Buku resep cetak', 'url', 'https://example.com/resep/rendang', 'active'],
  ['Galeri Foto Wisuda Angkatan 2026', 'Undangan wisuda', 'url', 'https://example.org/galeri/wisuda-2026', 'active'],
  ['Pendaftaran Lomba Karya Tulis Ilmiah', 'Poster lomba', 'url', 'https://example.org/lomba/kti', 'active'],
  ['Tiket Konser Amal Kampus', 'Tiket cetak', 'url', 'https://example.org/konser-amal/tiket', 'active'],
  ['Katalog Suku Cadang Bengkel Maju Jaya', 'Brosur bengkel', 'url', 'https://example.com/maju-jaya/suku-cadang', 'active'],
  ['Feedback Layanan Perpustakaan', 'Stiker meja layanan', 'url', 'https://example.org/perpus/feedback', 'active'],
  ['Data Aset Laboratorium Komputer', 'Label inventaris', 'url', 'https://example.org/aset/lab-komputer', 'active'],
  ['Pemesanan Kursi Ruang Baca', 'Stiker kursi', 'url', 'https://example.org/perpus/kursi', 'active'],
  ['Promo Ramadan Toko Kelontong Berkah', 'Spanduk promo', 'url', 'https://example.com/berkah/promo-ramadan', 'inactive'],
  ['Undian Hadiah Akhir Tahun', 'Kupon undian', 'url', 'https://example.com/undian/2026', 'inactive'],
  ['Brosur Open House 2025', 'Brosur tahun lalu', 'url', 'https://example.org/open-house/2025', 'inactive'],
  ['Diskon Hari Kemerdekaan', 'Poster promo 17 Agustus', 'url', 'https://example.com/promo/kemerdekaan', 'active', '2026-08-31 23:59:59'],
  ['Pendaftaran Bazar Mahasiswa', 'Poster bazar', 'url', 'https://example.org/bazar/daftar', 'active', '2026-09-10 17:00:00'],
  ['Undangan Pernikahan Sinta dan Bagas', 'Undangan cetak', 'url', 'https://example.com/undangan/sinta-bagas', 'active', '2027-03-20 23:59:59'],
  ['Pelatihan Barista Dasar Batch 4', 'Poster pelatihan', 'url', 'https://example.com/pelatihan/barista-4', 'active', '2026-12-31 23:59:59'],
];

// A few barcodes get a realistic edit history: [index in DEMO, [older url, ...], days ago of the first change]
const HISTORY = [
  [0, ['https://example.com/menu/warung-sate-2025', 'https://example.com/menu/warung-sate-pak-slamet-v2'], 24],
  [2, ['https://example.org/seminar/draft', 'https://example.org/seminar/teknologi-pertanian-lama'], 18],
  [6, ['https://example.com/kopi-tepi-sawah/lama'], 9],
  [12, ['https://wa.me/6281200009999'], 5],
];

async function ensureAdmin() {
  const existing = await db.one('SELECT id, username FROM users ORDER BY id LIMIT 1');
  if (existing) {
    console.log(`Admin sudah ada ("${existing.username}"), dilewati.`);
    return existing.id;
  }

  const username = process.env.SEED_ADMIN_USERNAME || 'admin';
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
  const name = process.env.SEED_ADMIN_NAME || 'Administrator';
  let password = process.env.SEED_ADMIN_PASSWORD || '';
  let generated = false;

  if (!password) {
    // Letters + digits, no look-alike characters.
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(18);
    password = `${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}9a`;
    generated = true;
  }
  if (config.isProd && /^(admin|password|changeme|ganti|admin#2026-dev)/i.test(password)) {
    throw new Error('SEED_ADMIN_PASSWORD terlalu lemah untuk production. Gunakan password yang kuat atau kosongkan agar dibuat acak.');
  }

  const user = await createUser(ctx, { name, username, email, password, role: 'admin' });
  console.log(`Admin dibuat: username "${user.username}", email ${user.email}`);
  if (generated) {
    console.log('----------------------------------------------------------------');
    console.log(`PASSWORD (hanya ditampilkan sekali): ${password}`);
    console.log('Simpan sekarang, lalu ganti lewat menu Pengaturan setelah login.');
    console.log('----------------------------------------------------------------');
  }
  return user.id;
}

async function seedDemo(adminId) {
  const { n } = await db.one('SELECT count(*)::bigint AS n FROM barcodes');
  if (n > 0 && !args.force) {
    console.log(`Tabel barcodes sudah berisi ${n} data, demo dilewati (gunakan --force untuk menambah).`);
    return;
  }

  const rows = DEMO.map(([name, description, targetType, targetUrl, status, expiredLocal]) => ({
    name, description, targetType, targetUrl, status, expiredLocal: expiredLocal ?? null,
  }));
  const inserted = await db.tx((tx) => barcodes.insertRows(tx, config, rows, { createdBy: adminId }));
  console.log(`${inserted.length} barcode demo dibuat.`);

  // Edit history: one row per past change, oldest first, ending in the current URL.
  const byName = new Map((await db.rows('SELECT id, name, target_url FROM barcodes WHERE id = ANY($1::bigint[])', [inserted.map((r) => r.id)])).map((r) => [r.name, r]));
  for (const [index, olderUrls, daysAgo] of HISTORY) {
    const target = byName.get(DEMO[index][0]);
    if (!target) continue;
    const chain = [...olderUrls, target.target_url];
    for (let i = 1; i < chain.length; i += 1) {
      await db.query(
        `INSERT INTO barcode_history (barcode_id, old_url, new_url, changed_by, changed_at)
         VALUES ($1, $2, $3, $4, now() - ($5::int * interval '1 day') - (random() * interval '8 hours'))`,
        [target.id, chain[i - 1], chain[i], adminId, Math.max(1, daysAgo - (i - 1) * 6)],
      );
    }
  }

  const scans = await insertSyntheticScans(db, config, { count: 1600, days: 30 });
  console.log(`${scans} scan contoh dibuat (30 hari terakhir).`);
}

try {
  const adminId = await ensureAdmin();
  const wantDemo = args.demo === true || (!args['no-demo'] && !config.isProd);
  if (wantDemo) await seedDemo(adminId);
  else console.log('Data demo dilewati.');
  console.log('Seed selesai.');
} catch (err) {
  console.error(`Seed gagal: ${err.message}`);
  process.exitCode = 1;
} finally {
  await ctx.db.end();
}
