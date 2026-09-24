// End-to-end smoke test against a RUNNING instance (development, staging or production), over real HTTP.
// It signs in, creates a temporary barcode, checks that the printed QR keeps working after the destination
// changes, then deletes the barcode again.
//
//   SMOKE_USERNAME=admin SMOKE_PASSWORD='...' npm run smoke -- --url http://localhost:3000
//   SMOKE_USERNAME=admin SMOKE_PASSWORD='...' npm run smoke -- --url https://barcode.contoh.com
//
// Notes: the temporary barcode consumes one number of the code sequence (a gap in numbering, harmless), and
// it adds one scan to the statistics of the temporary barcode only (deleted with it).
// The QR decoding step needs the dev dependencies "jsqr" and "pngjs"; without them that step is skipped.
import { parseArgs } from './lib/bootstrap.js';

const args = parseArgs();
const base = String(args.url || 'http://localhost:3000').replace(/\/+$/, '');
const username = process.env.SMOKE_USERNAME;
const password = process.env.SMOKE_PASSWORD;

if (!username || !password) {
  console.error('Isi SMOKE_USERNAME dan SMOKE_PASSWORD (akun admin) lewat environment variable.');
  process.exit(2);
}

// --- tiny HTTP client with a cookie jar ---------------------------------------------------------------------
const jar = new Map();
async function http(path, { method = 'GET', form, headers = {}, redirect = 'manual' } = {}) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(base + path, {
    method,
    redirect,
    headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (/expires=Thu, 01 Jan 1970/i.test(line) || pair.slice(eq + 1) === '') jar.delete(pair.slice(0, eq));
    else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return res;
}
const csrfFrom = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? /name="csrf-token" content="([^"]+)"/.exec(html)?.[1];

// --- assertions with readable output ------------------------------------------------------------------------
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  OK  ' : ' GAGAL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
  if (!ok) failures += 1;
}

async function decodeQr(bytes) {
  try {
    const [{ default: jsQR }, { PNG }] = await Promise.all([import('jsqr'), import('pngjs')]);
    const png = PNG.sync.read(bytes);
    return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
  } catch {
    return undefined; // decoder not installed
  }
}

let code;
try {
  console.log(`Smoke test terhadap ${base}\n`);

  // 1. health + landing
  let res = await http('/healthz');
  check('GET /healthz = 200 {"status":"ok"}', res.status === 200 && (await res.json()).status === 'ok', `HTTP ${res.status}`);
  res = await http('/');
  check('Landing page tampil', res.status === 200 && (await res.text()).includes('Login Admin'));

  // 2. login
  res = await http('/login');
  const loginToken = csrfFrom(await res.text());
  check('Halaman login memuat token CSRF', Boolean(loginToken));
  res = await http('/login', { method: 'POST', form: { _csrf: loginToken, identifier: username, password, next: '/admin' } });
  check('Login berhasil (302 ke /admin)', res.status === 302 && res.headers.get('location') === '/admin', `HTTP ${res.status} ${res.headers.get('location') ?? ''}`);
  if (res.status !== 302) throw new Error('Login gagal, pengujian dihentikan.');
  res = await http('/admin');
  check('Dashboard dapat dibuka', res.status === 200);

  // 3. create a temporary barcode
  const urlA = 'https://example.com/smoke-a';
  const urlB = 'https://example.com/smoke-b';
  res = await http('/admin/barcodes/new');
  let token = csrfFrom(await res.text());
  res = await http('/admin/barcodes', { method: 'POST', form: { _csrf: token, name: `Smoke Test ${new Date().toISOString()}`, description: 'Dibuat oleh scripts/smoke.js, dihapus otomatis', target_type: 'url', target_value: urlA, status: 'active' } });
  const location = res.headers.get('location') ?? '';
  code = /\/admin\/barcodes\/([A-Z]{1,6}-[A-Z0-9]+)$/.exec(location)?.[1];
  check('Barcode dibuat dan kode unik diterbitkan', res.status === 302 && Boolean(code), `HTTP ${res.status} ${location}`);
  if (!code) throw new Error('Barcode tidak terbuat.');
  console.log(`        kode: ${code}`);

  // 4. the QR encodes the dynamic URL (not the destination) and is downloadable as PNG and SVG
  res = await http(`/admin/barcodes/${code}/qr.png?download=1`);
  const png = Buffer.from(await res.arrayBuffer());
  check('QR PNG dapat diunduh (image/png, attachment)', res.status === 200 && res.headers.get('content-type') === 'image/png' && /attachment/.test(res.headers.get('content-disposition') ?? ''));
  res = await http(`/admin/barcodes/${code}/qr.svg?download=1`);
  const svg = await res.text();
  check('QR SVG dapat diunduh', res.status === 200 && svg.includes('<svg'));
  const printed = await decodeQr(png);
  let scanPath = `/b/${code}`;
  if (printed === undefined) console.log('  --    Decode QR dilewati (jsqr/pngjs tidak terpasang)');
  else {
    check('Isi QR = alamat redirect sistem, bukan tujuan', Boolean(printed) && new URL(printed).pathname === scanPath && !printed.includes('example.com'), String(printed));
    if (printed) scanPath = new URL(printed).pathname;
  }

  // 5. scanning follows the current destination
  res = await http(scanPath, { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36' } });
  check('Scan -> 302 ke tujuan A', res.status === 302 && res.headers.get('location') === urlA, `HTTP ${res.status} ${res.headers.get('location') ?? ''}`);
  check('Redirect tidak boleh di-cache (no-store)', /no-store/.test(res.headers.get('cache-control') ?? ''));

  // 6. change the destination: the SAME printed QR now leads elsewhere
  res = await http(`/admin/barcodes/${code}/edit`);
  token = csrfFrom(await res.text());
  res = await http(`/admin/barcodes/${code}`, { method: 'POST', form: { _csrf: token, name: 'Smoke Test (diubah)', description: '', target_type: 'url', target_value: urlB, status: 'active' } });
  check('URL tujuan diubah A -> B', res.status === 302, `HTTP ${res.status}`);
  res = await http(scanPath);
  check('QR yang sama sekarang mengarah ke tujuan B', res.status === 302 && res.headers.get('location') === urlB, `HTTP ${res.status} ${res.headers.get('location') ?? ''}`);
  res = await http(`/admin/barcodes/${code}/qr.png?download=1`);
  check('Berkas QR PNG identik setelah URL diubah (QR tidak dibuat ulang)', Buffer.from(await res.arrayBuffer()).equals(png));
  res = await http(`/admin/barcodes/${code}`);
  const detail = await res.text();
  check('Riwayat mencatat perubahan A -> B', detail.includes('smoke-a') && detail.includes('smoke-b'));

  // 7. inactive / active
  res = await http('/admin');
  token = csrfFrom(await res.text());
  res = await http(`/admin/barcodes/${code}/status`, { method: 'POST', form: { _csrf: token, status: 'inactive' } });
  res = await http(scanPath);
  check('Barcode nonaktif -> halaman "Barcode Tidak Aktif" (403)', res.status === 403 && (await res.text()).includes('Barcode Tidak Aktif'), `HTTP ${res.status}`);
  res = await http(`/admin/barcodes/${code}/status`, { method: 'POST', form: { _csrf: token, status: 'active' } });
  res = await http(scanPath);
  check('Diaktifkan kembali -> redirect lagi', res.status === 302);

  // 8. statistics saw the scans (the recorder writes right after the response, so allow a moment)
  await new Promise((r) => setTimeout(r, 400));
  res = await http(`/admin/barcodes/${code}`);
  const stats = await res.text();
  const totalScans = Number((/Total scan[\s\S]*?stat__value">([\d.]+)</.exec(stats)?.[1] ?? '0').replace(/\./g, ''));
  check('Statistik scan tercatat (Total scan >= 2)', totalScans >= 2, `terbaca ${totalScans}`);

  // 9. unknown code and CSRF
  res = await http('/b/BR-999999');
  check('Kode tidak dikenal -> "Barcode Tidak Ditemukan" (404)', res.status === 404 && (await res.text()).includes('Barcode Tidak Ditemukan'));
  res = await http(`/admin/barcodes/${code}/delete`, { method: 'POST', form: {} });
  check('POST tanpa token CSRF ditolak (403)', res.status === 403, `HTTP ${res.status}`);
} catch (err) {
  console.error(`\nPengujian terhenti: ${err.message}`);
  failures += 1;
} finally {
  // 10. cleanup: always try to delete the temporary barcode
  if (code) {
    try {
      let res = await http('/admin');
      const token = csrfFrom(await res.text());
      res = await http(`/admin/barcodes/${code}/delete`, { method: 'POST', form: { _csrf: token } });
      check(`Barcode sementara ${code} dihapus`, res.status === 302, `HTTP ${res.status}`);
      res = await http(`/b/${code}`);
      check('Setelah dihapus, QR menampilkan "Tidak Ditemukan"', res.status === 404);
    } catch (err) {
      console.error(`Pembersihan gagal, hapus ${code} secara manual: ${err.message}`);
      failures += 1;
    }
  }
  console.log(failures === 0 ? '\nSemua pemeriksaan lolos.' : `\n${failures} pemeriksaan GAGAL.`);
  process.exitCode = failures === 0 ? 0 : 1;
}
