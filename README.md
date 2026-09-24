# Dynamic Barcode Management System

Buat QR Code **dinamis**: yang dicetak hanya alamat sistem (`https://domain-anda/b/BR-000001`), sedangkan tujuan
sebenarnya (website, WhatsApp, email, telepon) tersimpan di database dan **bisa diubah kapan saja tanpa mencetak ulang**.

```
QR Code (tercetak, tetap)  ->  https://domain.com/b/BR-000001  ->  database  ->  URL tujuan (bisa diganti)
```

Dibangun dengan Node.js 20+ (Express 5), PostgreSQL, dan template Nunjucks. Tanpa framework frontend: HTML dari server,
sedikit JavaScript biasa, grafik SVG buatan sendiri, semua font dan ikon disajikan dari aplikasi (tanpa CDN).

## Isi

- [Fitur](#fitur)
- [1. Cara install](#1-cara-install)
- [2. Cara membuat database](#2-cara-membuat-database)
- [3. Konfigurasi .env](#3-konfigurasi-env)
- [4. Menjalankan migration](#4-menjalankan-migration)
- [5. Membuat akun admin](#5-membuat-akun-admin)
- [6. Menjalankan aplikasi](#6-menjalankan-aplikasi)
- [7. Deployment (hosting)](#7-deployment-hosting)
- [8. Struktur database](#8-struktur-database)
- [9. Backup dan restore database](#9-backup-dan-restore-database)
- [Cara kerja](#cara-kerja) | [Link edit tanpa login](#link-edit-tanpa-login) | [Ulasan Google Maps](#ulasan-google-maps) | [Kartu review cetak](#kartu-review-cetak) | [Format CSV](#format-csv-import) | [Keamanan](#keamanan) | [Performa 10.000 barcode](#performa-dan-kapasitas-10000-barcode) | [Pengujian](#pengujian) | [Struktur proyek](#struktur-proyek) | [Perintah npm](#perintah-npm) | [Pemecahan masalah](#pemecahan-masalah)

## Fitur

| Area | Yang tersedia |
| --- | --- |
| Barcode | Buat, ubah, hapus, aktif/nonaktif, kedaluwarsa opsional. Tipe tujuan: Website (http/https), WhatsApp, Email, Telepon. Kode unik `BR-000001` (atau acak, lihat `CODE_MODE`). |
| QR Code | Preview, unduh **PNG** (resolusi tinggi) dan **SVG** (vektor), halaman **cetak** dengan pilihan ukuran. Error correction level Q (25 %) agar tetap terbaca setelah dicetak. |
| Redirect | `GET /b/{kode}`: cek aktif, cek kedaluwarsa, catat scan, redirect **302** (tidak pernah di-cache). Halaman jelas untuk "Tidak Ditemukan", "Tidak Aktif", dan "Sudah Tidak Berlaku". Barcode yang belum diisi membuka halaman aktivasinya sendiri (lihat [Link edit tanpa login](#link-edit-tanpa-login)). |
| Isi nanti + link edit | Membuat barcode **tidak meminta link**: cukup nama, barcode langsung jadi (kode acak). Setiap barcode punya **link edit** (`/e/{token}`): siapa pun yang memegang link itu membuka **halaman aktivasi kartu** (kartu bermerek dengan QR dan tiga langkah aktivasi) lalu halaman form dengan **satu isian kosong, "Masukkan Maps"**, tanpa login. Admin bisa melihat, menyalin, membuat ulang, atau mencabut link dari halaman detail. Lihat [Link edit tanpa login](#link-edit-tanpa-login). |
| Ulasan Google Maps | Tempel link Google Maps (pendek atau panjang); sistem menghitung **Place ID** dan QR mengarah ke halaman tulis ulasan Google tempat itu. Tersedia di form admin dan di link edit. Lihat [Ulasan Google Maps](#ulasan-google-maps). |
| Kartu review cetak | Untuk barcode Ulasan Google Maps atau yang belum diisi, halaman cetak punya **kartu review** dua sisi (depan dengan QR, belakang dengan tiga langkah), ukuran kartu ID-1 atau besar, warna gelap atau terang, siap disimpan sebagai PDF. Lihat [Kartu review cetak](#kartu-review-cetak). |
| Statistik | Dashboard, Scan Analytics (7/30/90 hari, bulan ini, rentang kustom), per barcode: total, hari ini, minggu ini, bulan ini, grafik harian, perangkat, browser, sistem operasi, barcode terpopuler. |
| Riwayat | Setiap pengisian atau perubahan URL tujuan tercatat: waktu, URL lama, URL baru, dan siapa (admin, atau "Link edit" beserta IP-nya). |
| Massal | Import CSV (laporan berhasil/gagal per baris), export CSV, aksi massal (aktifkan, nonaktifkan, hapus, export) termasuk "pilih semua hasil filter". |
| Daftar | Pencarian nama/kode/URL, filter status dan tanggal, sorting, pagination (tidak pernah memuat 10.000 baris sekaligus). |
| Akun | Login, logout, session di database, password bcrypt, ganti password, profil, peran `admin` dan `viewer` (hanya-baca). |
| Operasional | Migration SQL, seed, generator 10.000 data uji, backup `pg_dump`, log terstruktur, health check `/healthz`. |

## 1. Cara install

Kebutuhan: **Node.js 20.11+** (seluruh tes lulus di Node 20.20 dan Node 24) dan **PostgreSQL 13+** (diuji di PostgreSQL 17; versi lain belum dicoba).

```bash
git clone <repo-anda> dynamic-barcode      # atau salin foldernya
cd dynamic-barcode
npm install                                # production: npm ci --omit=dev
cp .env.example .env                       # Windows PowerShell: Copy-Item .env.example .env
```

### Jalur cepat di Windows (tanpa menyentuh PostgreSQL yang sudah terpasang)

Proyek ini membawa skrip yang membuat **klaster PostgreSQL terpisah** di folder `.devdb` (port 54329, hanya localhost):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 init     # sekali saja
powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1 start     # setiap kali komputer dinyalakan
```

Skrip mencetak dua baris `DATABASE_URL` / `TEST_DATABASE_URL` yang tinggal Anda tempel ke `.env`. Perintah lain:
`stop`, `status`, `psql`, `destroy`. Kata sandi klaster ini hanya untuk lokal, bukan untuk production.

## 2. Cara membuat database

**Opsi A - otomatis** (butuh URL superuser PostgreSQL, hanya dipakai sekali dan tidak disimpan):

```bash
# Linux/macOS
ADMIN_DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/postgres npm run db:create
# Windows PowerShell
$env:ADMIN_DATABASE_URL="postgres://postgres:PASSWORD@localhost:5432/postgres"; npm run db:create
```

Skrip membuat role dan database sesuai `DATABASE_URL` di `.env`, mengaktifkan ekstensi `pg_trgm` (pencarian cepat)
dan aman dijalankan ulang.

**Opsi B - manual dengan psql:**

```sql
CREATE ROLE barcode_app LOGIN PASSWORD 'GANTI_PASSWORD_KUAT';
CREATE DATABASE barcode_dinamis OWNER barcode_app ENCODING 'UTF8' TEMPLATE template0;
\c barcode_dinamis
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- opsional; tanpa ini aplikasi tetap jalan
```

Untuk hosting terkelola (Neon, Supabase, RDS, dll.) cukup buat database dari panel penyedia lalu isi `DATABASE_URL`
(tambahkan `DATABASE_SSL=true` bila diwajibkan).

## 3. Konfigurasi .env

Semua konfigurasi lewat environment variable. Tidak ada kredensial di kode. Contoh lengkap dengan penjelasan ada di
[`.env.example`](.env.example). Yang wajib:

| Variabel | Contoh | Keterangan |
| --- | --- | --- |
| `APP_URL` | `https://barcode.contoh.com` | Alamat publik. **Ditanam di dalam QR Code.** Tetapkan domain final sebelum mencetak. |
| `DATABASE_URL` | `postgres://barcode_app:PASS@localhost:5432/barcode_dinamis` | Karakter khusus di password harus di-*percent-encode*. |
| `SESSION_SECRET` | 48+ karakter acak | Wajib di production. Buat: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `NODE_ENV` | `production` | Mengaktifkan cookie aman, cache aset, halaman error tanpa detail. |

Yang sering diubah:

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT`, `HOST` | `3000`, `127.0.0.1` (production: `0.0.0.0`) | Alamat listen. |
| `TRUST_PROXY` | `0` | Jumlah proxy tepercaya (Nginx = `1`). **Wajib diisi bila di belakang proxy**, kalau tidak semua pengunjung tampak berasal dari satu IP. |
| `APP_TIMEZONE` | `Asia/Jakarta` | Batas hari untuk "scan hari ini" dan tampilan tanggal (`23-09-2026 10:00`). |
| `BRAND_NAME` | `Riview Yuk` | Nama merek di halaman aktivasi kartu (link edit `/e/...`) yang dilihat pemegang kartu dan di kartu review cetak: judul tab, logo, dan kartu. Panel admin, halaman login, dan halaman status scan tetap memakai `APP_NAME`. |
| `CODE_MODE`, `CODE_PREFIX` | `sequential`, `BR` | `random` menghasilkan kode tak bisa ditebak (`BR-7K3M9QXT`). Barcode yang dibuat **tanpa tujuan** (kartu yang menunggu aktivasi) selalu memakai kode acak, apa pun `CODE_MODE`. |
| `QR_ERROR_CORRECTION` | `Q` | `L`/`M`/`Q`/`H`. |
| `REDIRECT_CACHE_TTL_MS` | `0` | Cache lookup di memori. `0` = selalu baca DB (perubahan langsung berlaku). |
| `REDIRECT_RATE_LIMIT_MAX` | `600`/menit/IP | Batas umum endpoint redirect. |
| `REDIRECT_404_RATE_LIMIT_MAX` | `30`/menit/IP | Batas khusus kode yang **tidak ada** (menghambat penebakan kode). |
| `LOGIN_RATE_LIMIT_MAX` | `10` per 15 menit | Percobaan login gagal per IP + username. |
| `PUBLIC_PAGE_RATE_LIMIT_MAX` | `120`/menit/IP | Batas untuk halaman login (mencegah bot menumpuk session). Session pengunjung yang belum login hanya berumur 1 jam. |
| `EDIT_LINK_RATE_LIMIT_MAX`, `EDIT_LINK_INVALID_RATE_LIMIT_MAX`, `EDIT_LINK_SAVE_RATE_LIMIT_MAX` | `60`/menit/IP, `10` per 10 menit/IP, `30`/jam/link | Batas link edit: semua permintaan, link yang **tidak dikenal** (menghambat penebakan), dan penyimpanan per link (link bocor tidak bisa membanjiri riwayat). |
| `MAPS_RESOLVE_TIMEOUT_MS` | `4000` | Batas waktu per permintaan saat server mengurai link pendek Google Maps (500 sampai 15000). Seluruh proses tidak pernah lebih dari 10 detik. |
| `IP_ANONYMIZE` | `false` | `true` = simpan IP tanpa oktet terakhir (privasi). |
| `IMPORT_MAX_ROWS`, `IMPORT_MAX_UPLOAD_MB` | `20000`, `5` | Batas import CSV. |
| `AUTO_MIGRATE` | `false` | `true` = jalankan migration otomatis saat start (Docker/PaaS). |
| `STORAGE_DIR`, `LOG_TO_FILE`, `LOG_LEVEL` | `storage`, `false` (dev) / `true` (production), `info` | Log JSON ke `storage/logs/app.log`. |

> Nilai yang mengandung `#` atau spasi harus diberi tanda kutip di `.env`, mis. `SEED_ADMIN_PASSWORD="Rahasia#123"`.
> Tanpa kutip, `#` dianggap awal komentar dan sisa nilainya terpotong.

Aplikasi menolak start dengan pesan jelas bila konfigurasi tidak valid (mis. `SESSION_SECRET` terlalu pendek di production).

## 4. Menjalankan migration

```bash
npm run migrate            # menerapkan migration yang belum dijalankan (aman dijalankan berulang)
npm run migrate:status     # daftar migration dan status penerapannya
npm run db:reset -- --yes  # HANYA development: hapus semua tabel lalu ulang dari awal (ditolak di production)
```

Migration adalah berkas SQL biasa di [`db/migrations`](db/migrations), dijalankan berurutan dalam satu transaksi
per berkas, dengan advisory lock (aman bila beberapa proses deploy bersamaan) dan checksum (peringatan bila berkas
lama diubah). Perubahan skema berikutnya: tambahkan berkas baru `0002_nama.sql`, jangan mengubah yang lama.

## 5. Membuat akun admin

```bash
npm run seed               # membuat admin dari SEED_ADMIN_* di .env + 30 barcode demo (di luar production)
npm run admin:create       # interaktif: nama, username, email, role, password (input password disembunyikan)
```

Tanpa interaksi:

```bash
ADMIN_PASSWORD='Rahasia-Bagus-88' npm run admin:create -- --name "Rina Kurnia" --username rina --email rina@contoh.co.id --role admin
```

- Lupa password? `npm run admin:reset -- --username admin` (minta password baru; semua sesi login akun itu berakhir).
- Jika `SEED_ADMIN_PASSWORD` kosong, `npm run seed` membuat password acak dan **menampilkannya sekali** di terminal.
- Di production seed hanya membuat admin (tanpa data demo) dan menolak password lemah. Gunakan `--demo` bila memang mau data contoh.
- Role: `admin` (penuh) atau `viewer` (hanya melihat dan export).
- Kebijakan password: minimal 8 karakter, mengandung huruf dan angka, tidak memuat username. Disimpan sebagai hash bcrypt.

## 6. Menjalankan aplikasi

```bash
npm run dev      # development: restart otomatis saat kode berubah
npm start        # production
```

Buka `http://localhost:3000` (atau port di `.env`), klik **Login Admin**. Cek kesehatan: `GET /healthz` mengembalikan `{"status":"ok"}`.

Menguji QR dari ponsel saat development: isi `APP_URL` dengan IP komputer di jaringan yang sama
(mis. `http://192.168.1.20:3100`) dan `HOST=0.0.0.0`, lalu buat barcode **setelah** `APP_URL` benar
(QR memuat alamat yang berlaku saat QR dibuat/diunduh).

### Data contoh dan uji beban

```bash
npm run data:generate                                  # +10.000 barcode
npm run data:generate -- --barcodes 10000 --scans 500000 --days 90   # plus 500 ribu scan sintetis
npm run data:generate -- --reset --yes                 # hapus semua barcode dulu (development saja)
```

## 7. Deployment (hosting)

Aplikasi cukup memerlukan **Node.js + PostgreSQL**. Pilihan hosting, dengan catatan apa yang sudah dan belum diuji:

| Pilihan | Cocok? | Catatan |
| --- | --- | --- |
| VPS Linux + Nginx + PM2 atau systemd | Ya, jalur yang dirinci di bawah | Instalasi produksi dari nol (`npm ci --omit=dev`, `db:create`, `migrate`, `seed`), PM2 cluster 2 worker termasuk `pm2 reload`, backup dan restore, serta perilaku HTTPS di belakang proxy sudah dicoba, di Windows dengan PostgreSQL 17. Contoh Nginx dan systemd, serta penghentian mulus lewat sinyal Linux, belum dijalankan. |
| PaaS Node/kontainer + PostgreSQL terkelola (Railway, Render, Fly.io, dsb.) | Bisa, belum diuji di platform-platform itu | Isi `NODE_ENV=production`, `APP_URL`, `DATABASE_URL` (+ `DATABASE_SSL`), `SESSION_SECRET`, `TRUST_PROXY=1`, `AUTO_MIGRATE=true`, `LOG_TO_FILE=false`, lalu buat admin sekali lewat konsol platform (`npm run seed`). Disk PaaS biasanya sementara, jadi backup memakai fitur penyedia database. |
| Hosting bersama (cPanel/PHP) | Hanya bila menyediakan Node.js 20+ **dan** PostgreSQL | Aplikasi ini proses Node yang terus berjalan, bukan skrip PHP. |
| Serverless (Vercel, Netlify, Cloudflare Workers) | Tidak | Butuh server yang terus berjalan, koneksi database tetap, dan rate limit/cache di memori proses. |

Urutan umum di server (VPS Ubuntu sebagai contoh):

```bash
# 1. kode + dependensi
git clone <repo> /srv/dynamic-barcode && cd /srv/dynamic-barcode
npm ci --omit=dev
# 2. konfigurasi
cp .env.example .env && nano .env      # APP_URL, DATABASE_URL, SESSION_SECRET, TRUST_PROXY=1, NODE_ENV=production
# 3. database
npm run db:create                      # atau buat manual (bagian 2)
npm run migrate
npm run seed                           # admin pertama; catat password acak yang tampil
# 4. jalankan dengan PM2 atau systemd
npm i -g pm2
pm2 start ecosystem.config.cjs --env production && pm2 save && pm2 startup
# 5. verifikasi dari luar (login, buat barcode sementara, uji QR, ubah URL, nonaktifkan, hapus)
SMOKE_USERNAME=admin SMOKE_PASSWORD='PASSWORD_ADMIN' npm run smoke -- --url https://barcode.contoh.com
```

`npm run smoke` menguji alur lengkap lewat HTTP nyata dan menghapus barcode sementaranya sendiri (nomor kode yang terpakai
akan tampak sebagai celah penomoran, tidak berbahaya). Decode QR-nya memerlukan `jsqr` dan `pngjs` (devDependencies); tanpa
keduanya langkah itu dilewati.

- **PM2**: [`ecosystem.config.cjs`](ecosystem.config.cjs), mode cluster 2 worker. Aman: session ada di PostgreSQL dan setiap scan
  ditulis atomik. Rate limit dan cache redirect bersifat per worker.
- **systemd** (alternatif): [`deploy/dynamic-barcode.service`](deploy/dynamic-barcode.service).
- **Nginx + HTTPS**: [`deploy/nginx.conf.example`](deploy/nginx.conf.example) (reverse proxy, batas upload, `certbot`).
  Pastikan `TRUST_PROXY=1` dan `APP_URL` memakai `https://`.
- **Docker** (contoh, **belum dijalankan** di lingkungan pengembangan karena Docker tidak tersedia; uji dulu sebelum dipakai):
  [`Dockerfile`](Dockerfile) dan [`docker-compose.yml`](docker-compose.yml) (`AUTO_MIGRATE=true`, PostgreSQL 17 dalam kontainer).
- **Update versi**: tarik kode, `npm ci --omit=dev`, `npm run migrate`, `pm2 reload dynamic-barcode`. Reload berjalan mulus:
  server menunggu request dan penulisan scan yang sedang berjalan sebelum berhenti.

Checklist production:

- [ ] Node.js 20.11+ (`node -v`); `npm ci` menolak versi yang lebih lama ([`.npmrc`](.npmrc))
- [ ] Server boleh membuka koneksi keluar HTTPS ke Google (`maps.app.goo.gl`, `goo.gl`, `g.page`): dipakai untuk mengurai link pendek Google Maps (firewall/egress PaaS)
- [ ] `NODE_ENV=production`, `APP_URL` = domain final dengan `https://`, `SESSION_SECRET` acak 48+ karakter
- [ ] File `.env` khusus server ini: jangan menyalin `.env` dari komputer pengembangan (isinya password lokal)
- [ ] `TRUST_PROXY` sesuai jumlah proxy, HTTPS aktif (cookie session otomatis `Secure`)
- [ ] Password admin awal sudah diganti lewat menu Pengaturan
- [ ] Backup terjadwal (bagian 9) dan pernah diuji restore
- [ ] Port PostgreSQL tidak terbuka ke internet; aplikasi memakai role khusus (bukan superuser)
- [ ] Log dipantau/di-rotate (`storage/logs/app.log`; contoh siap pakai: [`deploy/logrotate.example`](deploy/logrotate.example))

**Penting**: jangan mengganti domain setelah QR dicetak kecuali domain lama tetap mengarah ke aplikasi ini.

## 8. Struktur database

PostgreSQL. Skema lengkap: [`db/migrations/0001_init.sql`](db/migrations/0001_init.sql), lalu
[`0002_edit_links.sql`](db/migrations/0002_edit_links.sql) (tujuan boleh kosong, kolom link edit, asal perubahan riwayat) dan
[`0003_maps_review.sql`](db/migrations/0003_maps_review.sql) (tipe `maps_review`, kolom `maps_place_id` dan `maps_source_url`).

```
users 1---* barcodes 1---* barcode_scans
  |            |   1---* barcode_history
  |            |   1---* scan_stats_daily
  |            *---1 import_batches
  +--- created_by / changed_by (ON DELETE SET NULL)         user_sessions (penyimpanan session)
```

| Tabel | Kolom penting | Catatan |
| --- | --- | --- |
| `users` | `id`, `name`, `username`, `email`, `password_hash` (bcrypt), `role` (`admin`/`viewer`), `is_active`, `password_changed_at`, `created_at`, `updated_at` | Unik pada `lower(username)` dan `lower(email)`. Mengganti password mengakhiri semua session lain. |
| `barcodes` | `id`, **`code` (UNIQUE)**, `name`, `description`, `target_type`, `target_url` (**boleh `NULL`** = belum diisi), `status`, `expired_at`, `scan_count`, `last_scanned_at`, **`edit_token`** (UNIQUE bila terisi), `import_batch_id`, `created_by`, `created_at`, `updated_at` | `CHECK` di database menolak `target_url` selain `http(s)://`, `mailto:`, `tel:` (lapisan kedua di bawah validasi aplikasi). `edit_token` = rahasia acak 256 bit untuk link edit; `NULL` = tidak ada link. Status efektif: nonaktif, kedaluwarsa, **belum diisi** (`target_url` kosong), atau aktif. `target_type` juga bisa `maps_review`: `maps_place_id` (Place ID `ChIJ...`, **data utama**) dan `maps_source_url` (link Maps yang ditempelkan) terisi tepat ketika barcode bertipe itu dan sudah punya tujuan (dijaga `CHECK` di database). |
| `barcode_scans` | `id`, `barcode_id`, `scanned_at`, `ip_address` (INET), `user_agent`, `referer`, `device`, `browser`, `operating_system` | Log mentah, hanya ditambah (append-only). Boleh dipangkas tanpa merusak statistik. |
| `scan_stats_daily` | PK (`barcode_id`, `stat_date`, `device`, `browser`, `operating_system`), `scans` | **Rangkuman harian** yang dibaca semua statistik. Diperbarui atomik pada setiap scan. |
| `barcode_history` | `id`, `barcode_id`, `old_url` (`NULL` = pengisian pertama), `new_url`, `changed_by`, `changed_via` (`admin`/`edit_link`), `changed_ip`, `changed_at` | Satu baris per perubahan URL tujuan. Perubahan lewat link edit tidak punya `changed_by` (tanpa akun); `changed_ip` mengikuti `IP_ANONYMIZE`. |
| `import_batches` | `id`, `filename`, `total_rows`, `success_count`, `failed_count`, `first_code`, `last_code`, `errors` (JSONB), `created_by`, `created_at` | Laporan import, termasuk baris gagal dan alasannya. |
| `user_sessions` | `sid`, `sess`, `expire` | Dikelola `connect-pg-simple`. |

Index utama: `barcodes(code)` UNIQUE, `barcodes(status, created_at DESC)`, `barcodes(created_at DESC)`,
trigram GIN pada `code`, `name`, `target_url` (pencarian `ILIKE '%teks%'`), `barcode_scans(barcode_id, scanned_at DESC)`,
`barcode_scans(scanned_at)`, `barcode_history(barcode_id, changed_at DESC)`, `scan_stats_daily(stat_date)`.
`scan_count` dan `last_scanned_at` sengaja **tidak** di-index supaya update counter pada tiap scan menjadi *HOT update*.

## 9. Backup dan restore database

```bash
npm run db:backup                          # storage/backups/barcode-YYYYMMDD-HHmmss.dump (format custom, terkompresi)
npm run db:backup -- --out /mnt/backup --keep 30
```

Skrip mencari `pg_dump` sendiri (`PG_DUMP_PATH`, PATH, atau folder instalasi standar), menyimpan 14 backup terbaru secara
bawaan (`--keep` atau `BACKUP_KEEP`), dan tidak menaruh password di argumen perintah. Jadwalkan dengan cron:

```
30 2 * * *  cd /srv/dynamic-barcode && /usr/bin/npm run db:backup >> storage/logs/backup.log 2>&1
```

Restore (ke database kosong yang sudah dibuat):

```bash
pg_restore --clean --if-exists --no-owner --dbname "postgres://barcode_app:PASS@localhost:5432/barcode_dinamis" storage/backups/barcode-20260924-020000.dump
```

Alur backup dan restore ini sudah diuji: jumlah baris semua tabel identik setelah restore. Simpan salinan backup di luar server.
Backup memuat `barcodes.edit_token` (rahasia link edit) dan hash password, jadi perlakukan berkasnya sebagai data sensitif.

## Cara kerja

1. Admin membuat barcode. Sistem membuat kode unik (`BR-000001`, dari sequence database sehingga tidak pernah bertabrakan atau dipakai ulang).
2. QR Code dibuat dari `APP_URL + /b/ + kode`. **Tujuan tidak pernah masuk ke QR.**
3. Saat dipindai, `/b/{kode}` mencari kode di database (satu query ber-index), memeriksa status dan kedaluwarsa, lalu mengirim
   redirect `302` ke tujuan **dan** mencatat scan setelah respons dikirim, jadi pengunjung tidak menunggu penulisan statistik.
4. Mengubah URL hanya mengubah satu baris di database (dan menambah baris riwayat). QR yang sudah tercetak tetap valid.

Kegagalan pencatatan statistik tidak pernah menggagalkan redirect. Bila database lambat, antrean penulisan dibatasi dan
statistik yang dikorbankan, bukan redirect.

## Link edit tanpa login

Untuk barcode yang tujuannya belum diketahui saat dibuat, atau yang tujuannya akan diisi orang lain:

1. **Buat barcode tanpa mengisi link.** Form Buat Barcode hanya meminta nama (isian tujuan disembunyikan; buka bila sudah tahu tujuannya).
   Barcode langsung dibuat: kode **acak** (mis. `BR-7K3M9QXT`, apa pun `CODE_MODE`), QR siap dicetak, dan **link edit** otomatis. Status efektifnya **Belum diisi**.
2. **Scan pertama membuka halaman aktivasi.** Yang memindai barcode yang belum diisi langsung dibawa ke link edit-nya (`https://domain-anda/e/{token}`),
   jadi pemilik kartu tidak perlu dikirimi apa pun. Ini tidak dihitung sebagai scan. Halaman "Barcode Belum Diisi" hanya muncul bila link edit dicabut
   atau kodenya berurutan (lihat catatan keamanan di bawah). Link yang sama tetap bisa dikirim lewat halaman detail (kartu "Link edit tanpa login");
   barcode lama belum punya link, klik **Buat link edit** untuk membuatnya.
3. **Pemegang link membuka dua halaman tanpa login.** Link itu (`/e/{token}`) membuka **halaman aktivasi kartu**: kartu bermerek
   ([`BRAND_NAME`](#3-konfigurasi-env), bawaan "Riview Yuk") berisi QR, kode, nama, dan status, lalu tiga langkah (kartu terdaftar, Masukkan Maps,
   kartu siap dipindai) yang menunjukkan sampai mana aktivasinya. Halaman ini tidak punya form. Tombol **Aktifkan kartu** (**Ganti lokasi Maps**
   bila sudah terhubung) membuka **halaman form** (`/e/{token}/edit`) dengan **satu isian yang selalu kosong**: link Google Maps lokasi mereka.
   Sistem mengubahnya menjadi halaman ulasan Google (lihat [Ulasan Google Maps](#ulasan-google-maps)). Setelah tersimpan, orangnya kembali ke
   halaman aktivasi yang menampilkan konfirmasi. QR yang sudah dicetak langsung mengarah ke halaman ulasan itu, dan link tetap berlaku bila
   lokasinya perlu diganti.
4. **Admin tetap memegang kendali**: melihat setiap pengisian di riwayat (ditandai "Link edit" + IP), **membuat ulang** link
   (link lama langsung mati) atau **mencabutnya**. Menghapus barcode juga mematikan linknya.

Yang bisa dilakukan pemegang link **hanya memasukkan link Google Maps** untuk barcode itu. Ia **tidak bisa** mengarahkan barcode ke website
atau alamat lain (hanya halaman ulasan Google yang bisa dihasilkan), dan tidak bisa mengosongkan Maps yang sudah terisi. Nama, keterangan,
status, masa berlaku, statistik, penghapusan, dan barcode lain tidak terjangkau. Halaman aktivasi menampilkan kode, nama (bukan keterangan),
dan QR agar orangnya tahu kartu mana yang ia isi, tetapi tidak menampilkan alamat apa pun; halaman form tidak menampilkan apa yang sudah
tersimpan. Hanya halaman form yang menerima penyimpanan. Akun `viewer` tidak melihat link, karena link adalah hak menulis.
Tampilannya murni presentasi: teks dan langkah mengikuti status barcode (belum diisi, aktif, nonaktif, kedaluwarsa), tidak ada logika lain.

Cara linknya diamankan (link adalah kredensial, jadi diperlakukan seperti kata sandi):

- **Memegang kartu = boleh mengaktifkannya, sampai Maps diisi.** Barcode yang belum diisi menyerahkan link edit-nya kepada siapa pun yang memindainya.
  Karena itu hanya **kode acak** yang boleh melakukannya: dengan kode berurutan (`BR-000001`, `BR-000002`, ...) orang bisa menghitung kode dan
  mengumpulkan link setiap kartu yang belum aktif dari jauh. Barcode tanpa tujuan selalu dibuat dengan kode acak; barcode dengan kode berurutan
  (mis. dibuat sebelum fitur ini) tetap menampilkan "Barcode Belum Diisi" dan tidak membuka apa pun. Setelah tujuan terisi, scan langsung ke tujuan dan
  link edit tidak pernah keluar dari server lagi (simpan alamat halaman aktivasi bila ingin mengganti lokasi nanti, atau minta admin mengirim link-nya).
- Token acak 256 bit (`crypto.randomBytes(32)`, 43 karakter), tidak bisa ditebak; bentuk yang salah ditolak tanpa menyentuh database.
- Semua respons di kedua halaman `no-store`, `noindex`, `Referrer-Policy: no-referrer` (token tidak bocor lewat header Referer), tidak bisa di-embed (`frame-ancestors 'none'`), dan `robots.txt` melarang `/e/`.
- **Tanpa cookie dan tanpa session**: tidak ada yang bisa "ditunggangi" situs lain, sehingga CSRF token tidak dibutuhkan; kredensialnya adalah link itu sendiri.
- Token disamarkan di log aplikasi (`/e/[redacted]`). Contoh konfigurasi Nginx di [`deploy/nginx.conf.example`](deploy/nginx.conf.example) juga menyamarkannya di access log
  (contoh itu belum dijalankan di mesin pengembangan; uji dulu dengan `nginx -t`).
- Tiga rate limit (lihat `EDIT_LINK_*`), batas ukuran body 16 KB, dan penyimpanan dikunci per baris sehingga dua orang yang menyimpan bersamaan tidak merusak riwayat.
- Link tersimpan apa adanya di database (agar admin bisa menyalinnya lagi), jadi backup database perlu diperlakukan sebagai data sensitif.
  Bila sebuah link tersebar ke orang yang salah: **Cabut** atau **Buat ulang** dari halaman detail.

## Ulasan Google Maps

Tipe tujuan **Ulasan Google Maps**: pemilik tempat menempelkan link lokasinya di Google Maps, dan QR Code mengarah ke halaman
**tulis ulasan** Google untuk tempat itu (`https://search.google.com/local/writereview?placeid=<Place ID>`). Tipe ini ada di form admin
(Buat/Edit Barcode) dan menjadi satu-satunya isian di halaman link edit. Dari link Maps sampai link ulasan:

1. **Validasi host.** Hanya `google.com/maps`, `maps.google.*`, `goo.gl/maps`, `maps.app.goo.gl`, dan `g.page` yang diterima (cocok persis:
   `google.com.evil.test` atau `evilgoogle.com` ditolak). Link tanpa `https://` juga bisa; `http://` dinaikkan ke `https://`.
2. **Link pendek menjadi URL penuh (hanya `goo.gl`, `maps.app.goo.gl`, `g.page`), di server** karena browser diblokir CORS. Server mengirim
   GET **tanpa mengikuti redirect otomatis**, hanya membaca header `Location`, membuang isi halamannya (tidak diunduh), dan mengulang maksimal
   **5 kali**, hanya ke domain Google. Redirect ke tempat lain tidak pernah diikuti (permintaannya pun tidak dikirim). Batas waktu per
   permintaan `MAPS_RESOLVE_TIMEOUT_MS` (bawaan 4 detik) dan 10 detik untuk seluruh proses.
3. **ID lokasi** dibaca dari URL yang sudah di-decode: `!1s0xAAAA:0xBBBB` atau `ftid=0xAAAA:0xBBBB`. Cadangan (hanya dipakai bila
   ID lokasi tidak ada): bila alamat akhirnya sudah membawa Place ID (`placeid=ChIJ...`, mis. hasil dari link ulasan bawaan Google Business
   Profile `g.page/r/.../review`, atau `place_id:ChIJ...`), Place ID itu dipakai langsung. Untuk link yang punya keduanya, rumus di atas yang menang.
4. **Place ID** dihitung dari 20 byte `0A 12 09` + AAAA (8 byte little-endian) + `11` + BBBB (8 byte little-endian), di-encode base64url tanpa
   padding; hasilnya selalu berawalan `ChIJ` (27 karakter). Rumus ini dicocokkan dengan contoh Place ID dari dokumentasi Google dan dengan
   link Maps asli.
5. **Link ulasan** dibuat dari Place ID.
6. **Yang disimpan**: `barcodes.maps_place_id` sebagai **data utama**, `maps_source_url` (link yang ditempelkan) sebagai pelengkap, dan
   `target_url` berisi link ulasan yang dipakai endpoint redirect. Karena link ulasan selalu bisa dibangun ulang dari Place ID, formatnya
   mudah diganti: ubah fungsi `reviewUrlFor` di [`src/lib/google-maps.js`](src/lib/google-maps.js) lalu jalankan
   `npm run maps:rebuild` (pratinjau) dan `npm run maps:rebuild -- --yes` (menulis). QR yang sudah tercetak tidak terpengaruh.

Hal yang perlu diketahui:

- **Server harus bisa membuka koneksi keluar HTTPS ke Google** (`maps.app.goo.gl`, `goo.gl`, `g.page`) untuk mengurai link pendek. Link panjang
  dari `google.com/maps` tidak memerlukan koneksi apa pun. Bila koneksi keluar diblokir, pengguna melihat pesan "Link pendek tidak bisa
  dibuka saat ini".
- Karena server mengambil alamat yang diberikan pengguna, pengamannya berlapis: daftar host di atas, setiap lompatan diperiksa sebelum
  dikirim, hanya `https`, tanpa username/password/port khusus, batas 5 lompatan dan batas waktu, isi halaman tidak diunduh, dan permintaan
  ke link edit yang tidak valid tidak pernah memicu permintaan keluar. Permintaan ke Google dilakukan **di luar transaksi database**, jadi
  jawaban lambat tidak menahan kunci baris barcode.
- Hanya link yang membawa ID lokasi (`0x...:0x...`) yang bisa dipakai. Link koordinat saja (`google.com/maps?q=-7.7,110.3`) ditolak dengan
  pesan cara menyalin link yang benar (Bagikan, lalu Salin link). Domain negara seperti `google.co.id/maps` tidak ada di daftar; linknya
  dari tombol Bagikan (`maps.app.goo.gl`) selalu diterima.
- Form edit admin menampilkan **link Maps yang ditempelkan**, bukan link ulasan. Menyimpan ulang dengan link yang sama tidak menghubungi
  Google lagi dan tidak menambah riwayat. Halaman link edit publik selalu kosong saat dibuka.
- Import CSV tidak bisa membuat tipe ini (hanya URL biasa).

## Kartu review cetak

Untuk barcode tipe **Ulasan Google Maps** dan barcode yang **belum diisi**, halaman cetak (`/admin/barcodes/{kode}/print`) punya pilihan **Kartu review**
di samping label QR biasa. Tombol **Cetak kartu** di halaman detail dan di menu baris daftar langsung membukanya (`?layout=card`). Barcode dengan tujuan lain
tidak memilikinya, karena tulisan di kartu ("Pindai untuk menulis ulasan di Google") hanya benar untuk dua jenis itu.

Kartu ini kembaran cetak dari kartu di halaman aktivasi (`/e/{token}`): latar hampir hitam, huruf Geist dan Instrument Serif, lima bintang, dan QR asli di ubin putih,
dengan nama merek dari [`BRAND_NAME`](#3-konfigurasi-env). Gambarnya memakai satuan relatif terhadap lebar kartu, jadi satu rancangan berlaku untuk kedua ukuran.

| Sisi | Isi |
| --- | --- |
| Depan | Merek dan lima bintang, "Bagikan pengalaman Anda", ajakan memindai, QR, nama barcode, dan kodenya. |
| Belakang | Tiga langkah menulis ulasan, dan alamat pendek (tanpa `https://`) untuk diketik bila pemindaian gagal. |

Pilihan di bilah atas: **Bentuk** (label atau kartu), **Ukuran kartu** (Standar 8,56 × 5,4 cm seperti kartu ID-1, atau Besar 14,5 × 9,2 cm), dan
**Warna** (Gelap, atau Terang yang hemat tinta dan cocok untuk kertas biasa). Pilihan itu digerakkan CSS `:has()` tanpa skrip, jadi butuh browser yang cukup baru
(Chrome/Edge 105+, Safari 15.4+, Firefox 121+).

Catatan cetak:

- Simpan sebagai PDF dari dialog cetak browser: halaman 1 = depan, halaman 2 = belakang, masing-masing **seukuran kartu** tanpa margin (`@page` bernama). PDF itu
  bisa dibawa ke percetakan. Untuk dicetak sendiri di kertas A4, potong mengikuti tepi kartu (kartu Terang punya garis tepi tipis sebagai pemandu).
- Latar gelap tetap tercetak walau opsi "Background graphics" browser mati (`print-color-adjust: exact`); tanpa itu kartu gelap keluar sebagai huruf putih di kertas putih.
- Gambarnya persegi penuh: tanpa sudut membulat (percetakan yang memotongnya) dan **tanpa bleed**. Percetakan yang meminta bleed 3 mm perlu versi dengan margin tambahan.
- Link edit rahasia (`/e/{token}`) **tidak pernah** dicetak di kartu.
- Diuji: jumlah dan ukuran halaman PDF (Edge headless), latar gelap benar-benar tercetak (dibandingkan dengan kontrol tanpa aturan itu), teks tiap halaman, dan QR pada hasil cetak
  terbaca pembaca independen (jsQR) di ketiga varian. Belum diuji: printer fisik dan Safari/Firefox.

## Format CSV import

```csv
name,description,target_url,status,expired_at
Produk A,Produk pertama,https://example.com/a,active,
Produk B,Produk kedua,https://example.com/b,inactive,31-12-2026
```

- Wajib: `name`, `target_url` (http/https). Opsional: `description`, `status` (`active`/`inactive`/`aktif`/`nonaktif`), `expired_at`.
  (Import selalu butuh tujuan di setiap baris. Barcode tanpa tujuan dibuat lewat form; lihat [Link edit tanpa login](#link-edit-tanpa-login).
  Barcode hasil import juga mendapat link edit.)
- `expired_at`: `2026-12-31`, `31-12-2026` (tanpa jam = akhir hari) atau `2026-12-31 17:00` (waktu `APP_TIMEZONE`).
- Pemisah koma, titik koma (Excel Indonesia), atau tab dikenali otomatis. Nama kolom Indonesia (`nama`, `keterangan`, `url`, `kedaluwarsa`) juga dikenali.
- Kode selalu dibuat sistem. Baris yang salah **dilewati dan dilaporkan** (nomor baris seperti di spreadsheet + alasan); baris valid tetap masuk,
  semuanya dalam satu transaksi. Laporan bisa diunduh sebagai CSV untuk diperbaiki dan diunggah ulang.
- Unduh contoh dari halaman Import (`/admin/import/template.csv`).
- Export (`/admin/barcodes/export.csv`) mengikuti filter dan memuat kolom `qr_url`. Sel yang diawali `=`, `+`, `-`, `@` diberi apostrof agar tidak dieksekusi
  Excel sebagai rumus (CSV injection). Pilih "Titik koma" bila Excel Anda memakai pengaturan regional Indonesia.

## Keamanan

| Risiko | Penanganan |
| --- | --- |
| Password | bcrypt (cost 12), tidak pernah plaintext, kebijakan password, waktu respons sama untuk user tidak dikenal, pesan galat seragam |
| Session | Server-side di PostgreSQL, cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` di HTTPS), id baru saat login, semua session berakhir saat password diganti |
| CSRF | Token per session pada setiap form/POST (juga login dan logout), tolak `Sec-Fetch-Site: cross-site`; logout hanya via POST |
| SQL injection | Query berparameter di seluruh aplikasi; kolom sorting berasal dari daftar putih; wildcard `%`/`_` pada pencarian di-escape |
| XSS | Auto-escape di semua template; CSP ketat (`script-src 'self'`, tanpa inline script); teks pengguna dibersihkan dari karakter kontrol/bidi; `textContent` untuk toast dan tooltip |
| URL berbahaya | Hanya `http://` dan `https://` (plus `mailto:`/`tel:` yang dibangun sistem); tolak `javascript:`, `data:`, `file:`, kredensial dalam URL, spasi/kontrol, redirect ke `/b/` milik sendiri; `CHECK` constraint di database |
| Penebakan kode | Rate limit per IP + batas khusus untuk kode yang tidak ada; opsi kode acak (`CODE_MODE=random`). Barcode tanpa tujuan selalu berkode acak, karena scan-nya membuka link edit |
| Otorisasi | Semua `/admin` wajib login; setiap aksi ubah data memeriksa peran `admin`; area import hanya admin |
| Kebocoran informasi | Halaman status barcode tidak menampilkan tujuan/DB; error production hanya berisi ID permintaan; `X-Powered-By` dimatikan; header keamanan (Helmet) |
| CSV | Guard rumus saat export, parser aman, batas ukuran dan jumlah baris, file tidak pernah ditulis ke disk |
| Open redirect | Parameter `next` dan `return_to` hanya menerima path internal `/admin...` |
| Link edit tanpa login | Token acak 256 bit sebagai kredensial; tanpa cookie/session; pemegang link **hanya bisa memasukkan link Google Maps** (tidak bisa mengarahkan ke website sembarang); 3 rate limit; disamarkan di log; dapat dicabut atau dibuat ulang admin; tidak terlihat oleh `viewer`; setiap perubahan tercatat dengan IP. Rincian di [Link edit tanpa login](#link-edit-tanpa-login) |
| Server mengambil alamat dari pengguna (SSRF) | Hanya untuk link pendek Google Maps: daftar host yang ketat, setiap lompatan redirect diperiksa **sebelum** dikirim dan harus ke domain Google, maksimal 5 lompatan, hanya `https`, isi halaman tidak diunduh, batas waktu, tidak ada redirect otomatis, dan tidak dilakukan untuk link edit yang tidak valid. Rincian di [Ulasan Google Maps](#ulasan-google-maps) |

Data yang disimpan tiap scan: waktu, IP (bisa dianonimkan), user agent (dipangkas 512 karakter), referer (hanya asal + path, tanpa query),
jenis perangkat, browser, OS. Perhatikan kewajiban privasi yang berlaku bagi Anda (mis. UU PDP) sebelum mengaktifkan penyimpanan IP penuh.

## Performa dan kapasitas 10.000 barcode

- Lookup redirect memakai unique index (`EXPLAIN` diuji: bukan sequential scan). Jalur `/b/` dipasang **sebelum** session, body parser, CSRF, dan logging.
- Daftar barcode berhalaman (25/halaman, maks 100); halaman di luar jangkauan diarahkan ke halaman terakhir; total dihitung dengan `count(*)` berindeks.
- Statistik dibaca dari **rangkuman harian** (`scan_stats_daily`), bukan dari log mentah, jadi tetap cepat walau `barcode_scans` berisi jutaan baris.
- Export CSV di-stream dengan keyset pagination (memori konstan); import memasukkan 1.000 baris per statement (array + `unnest`).
- Hasil uji di mesin pengembangan (`tests/integration/scale.test.js`, 10.000 barcode + 300.000 scan): halaman daftar sekitar 0,1 detik, ekspor 10.000 baris sekitar 0,5 detik,
  200 scan konkuren tanpa satu pun hilang, hapus massal 10.000 barcode beserta 300.000 scan sekitar 3 detik.

Perawatan log mentah (opsional, statistik harian tidak terpengaruh):

```sql
DELETE FROM barcode_scans WHERE scanned_at < now() - interval '365 days';
```

## Pengujian

```bash
npm test          # 396 tes: unit + integrasi (butuh TEST_DATABASE_URL, mis. barcode_dinamis_test), sekitar 3 menit
```

Tes **menolak berjalan** jika nama database tidak berakhiran `_test` karena tabelnya dikosongkan di setiap tes.
Cakupan: pembuatan dan pengeditan barcode, redirect (aktif, tidak ditemukan, nonaktif, kedaluwarsa), login/logout/role/rate limit,
import dan export CSV, aksi massal, statistik scan (zona waktu, minggu/bulan, rollup), riwayat perubahan, keamanan (CSRF, SQLi, XSS, header, error production),
skrip CLI (`seed`, `admin:create`, `admin:reset`, `data:generate`, `migrate`), kapasitas 10.000 barcode, dan tes khusus **"QR yang sudah dicetak tetap berfungsi setelah URL diubah"**
(QR di-decode dengan pembaca independen: alamat di dalam QR tidak pernah berubah, 25 kali ganti tujuan, berkas PNG/SVG identik byte demi byte).
Fitur **isi nanti + link edit** punya tesnya sendiri (`tests/integration/edit-link.test.js`, `edit-link-public.test.js`, `tests/unit/edit-link.test.js`): form buat barcode tanpa isian link dan kode acak untuk barcode tanpa tujuan, scan pertama yang membuka halaman aktivasi (hanya untuk kode acak dan link yang belum dicabut), halaman "Belum Diisi",
halaman aktivasi dan halaman form yang terpisah (form selalu kosong), tampilan tiap status (belum aktif, aktif, nonaktif, kedaluwarsa), nama merek dari `BRAND_NAME`, pengisian tanpa login, link mati/dicabut/dibuat ulang, hanya link Maps yang bisa dimasukkan, validasi, rate limit, penyimpanan serentak, `viewer` tidak melihat link,
token tidak muncul di halaman lain maupun di log, dan QR yang dicetak sebelum tujuan ada tetap berfungsi setelah diisi.
Fitur **Ulasan Google Maps** juga: `tests/unit/google-maps.test.js` (rumus Place ID dengan contoh dari dokumentasi Google, daftar host yang diterima dan ditolak,
redirect yang meninggalkan Google tidak pernah dikirim, batas 5 lompatan dan batas waktu) dan `tests/integration/maps-admin.test.js` (form admin, `CHECK` di database,
Google ditanya tanpa menahan kunci baris). Tidak ada tes yang menghubungi jaringan: link pendek dijawab oleh tiruan Google.
**Kartu review cetak** punya `tests/integration/print-card.test.js`: kartu hanya untuk barcode Maps atau yang belum diisi, `?layout=card` dan nilai yang salah, isi depan dan belakang,
link edit tidak pernah tercetak, teks berbahaya di-escape, tombol "Cetak kartu", label lama tidak berubah, dan aturan cetak yang rapuh (latar dipaksa tercetak, ukuran halaman, satu kartu per halaman).

## Struktur proyek

```
src/
  server.js  app.js  context.js  views.js       titik masuk, perakitan Express, dependensi bersama
  config/                                          parsing dan validasi environment
  db/                                              pool pg, runner migration
  lib/                                             QR, kode, user agent, CSV, tanggal/zona waktu, IP, teks (fungsi murni)
  middleware/                                      keamanan, session, CSRF, flash, auth, rate limit, error
  modules/
    barcodes/      repo (SQL), service (aturan), routes, validasi, tipe tujuan
    redirect/      endpoint /b/{kode} dan cache
    edit-link/     halaman publik tanpa login: /e/{token} (aktivasi kartu) dan /e/{token}/edit (form "Masukkan Maps")
    maps/          pengurai link Google Maps di server (link pendek, hanya ke domain Google)
    analytics/     pencatat scan, query statistik, rentang tanggal
    imports/       import/export CSV
    auth/  settings/  admin/  public/
  views/           template Nunjucks (layouts, macros, halaman)
  public/          css, js (app, charts, barcodes), font, ikon
db/migrations/     skema SQL
scripts/           migrate, seed, admin, generator data, backup, db:create, run-tests, dev-db.ps1
tests/             unit/ dan integration/
deploy/            contoh Nginx dan systemd
```

Pemisahan tanggung jawab: **Frontend** (`views`, `public`), **Backend** (`modules`, `middleware`), **Database** (`db`),
**Authentication** (`modules/auth`, `middleware/auth+csrf+session`), **Barcode generator** (`lib/qr.js`, `lib/codes.js`),
**Redirect system** (`modules/redirect`), **Analytics** (`modules/analytics`).

## Perintah npm

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` / `npm start` | Jalankan aplikasi (dev dengan auto-restart / production) |
| `npm run migrate`, `migrate:status`, `db:reset -- --yes` | Migration |
| `npm run db:create` | Buat role + database (butuh `ADMIN_DATABASE_URL`) |
| `npm run seed`, `admin:create`, `admin:reset` | Admin pertama, data contoh, akun baru, reset password |
| `npm run smoke -- --url <alamat>` | Uji alur lengkap terhadap instance yang berjalan (butuh `SMOKE_USERNAME`/`SMOKE_PASSWORD`) |
| `npm run data:generate` | Data uji beban (10.000 barcode, scan sintetis) |
| `npm run maps:rebuild` | Bangun ulang link ulasan semua barcode Google Maps dari Place ID-nya (pratinjau; tambah `-- --yes` untuk menulis) |
| `npm run db:backup` | Backup `pg_dump` |
| `npm run icons:build` | Bangun ulang `src/lib/icons.generated.js` dari Phosphor Icons |
| `npm test` | Seluruh tes |

## Pemecahan masalah

| Gejala | Penyebab / solusi |
| --- | --- |
| `Konfigurasi (.env) tidak valid` | Baca daftar galat yang tercetak; biasanya `SESSION_SECRET`, `APP_URL`, atau `DATABASE_URL`. |
| `Tidak dapat terhubung ke database` | PostgreSQL belum jalan (`scripts/dev-db.ps1 start`) atau `DATABASE_URL` salah (password dengan karakter khusus perlu di-encode). |
| Login berhasil tapi langsung keluar di production | `NODE_ENV=production` dengan `APP_URL` https membuat cookie `Secure`; akses lewat HTTPS dan set `TRUST_PROXY=1` di belakang proxy. |
| Semua scan tercatat dari satu IP / rate limit terlalu ketat | `TRUST_PROXY` belum diisi di belakang Nginx/Cloudflare. |
| QR mengarah ke `localhost` | `APP_URL` masih alamat development saat QR dibuat; perbaiki `APP_URL`, restart, unduh ulang QR. |
| "Link pendek tidak bisa dibuka saat ini" saat memasukkan Maps | Server tidak bisa membuka koneksi keluar HTTPS ke Google (firewall/egress) atau lambat: cek dengan `curl -I https://maps.app.goo.gl/xxxx` dari server, atau naikkan `MAPS_RESOLVE_TIMEOUT_MS`. Link panjang dari `google.com/maps` tetap bisa dipakai. |
| "ID lokasi tidak ditemukan di link ini" | Link Maps tidak membawa ID lokasi (mis. hanya koordinat). Buka lokasinya di Google Maps, pilih Bagikan, lalu Salin link. |
| Password di `.env` terpotong | Nilai dengan `#` harus diberi tanda kutip. |
| Excel membuka CSV dalam satu kolom | Export dengan pemisah "Titik koma" atau impor data lewat Data > From Text/CSV. |

## Lisensi pihak ketiga

Font Geist dan Instrument Serif (SIL Open Font License 1.1, berkas lisensi di `src/public/fonts`), ikon Phosphor (MIT).
Pustaka: Express, Nunjucks, pg, bcryptjs, helmet, express-rate-limit, multer, csv-parse, qrcode, pino, dan lainnya (semua MIT/BSD/Apache).
