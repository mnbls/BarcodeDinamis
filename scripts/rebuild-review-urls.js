// Rebuilds the review address of every "Ulasan Google Maps" barcode from its stored Place ID.
//
//   npm run maps:rebuild            -> shows what would change (nothing is written)
//   npm run maps:rebuild -- --yes   -> writes the changes
//
// The Place ID is the primary data of such a barcode and the review link is derived from it (reviewUrlFor in
// src/lib/google-maps.js). If Google changes the format of that link, change reviewUrlFor and run this script once:
// every barcode is updated in place and nobody has to paste a Maps link again. The printed QR codes are not affected.
//
// The change is not written to the history (the place is the same, only the address format differs), and a running
// server that keeps a redirect cache (REDIRECT_CACHE_TTL_MS > 0) shows the new address after that TTL.
import { reviewUrlFor } from '../src/lib/google-maps.js';
import { bootstrap, parseArgs } from './lib/bootstrap.js';

const args = parseArgs();
const { ctx, db } = bootstrap();

try {
  const rows = await db.rows(
    "SELECT id, code, maps_place_id, target_url FROM barcodes WHERE target_type = 'maps_review' AND maps_place_id IS NOT NULL ORDER BY id",
  );
  const stale = rows.filter((row) => row.target_url !== reviewUrlFor(row.maps_place_id));

  console.log(`${rows.length} barcode Ulasan Google Maps, ${stale.length} perlu diperbarui.`);
  for (const row of stale.slice(0, 20)) console.log(`  ${row.code}\n    sekarang: ${row.target_url}\n    baru:     ${reviewUrlFor(row.maps_place_id)}`);
  if (stale.length > 20) console.log(`  ... dan ${stale.length - 20} lainnya`);

  if (stale.length === 0) {
    console.log('Semua sudah sesuai format terbaru.');
  } else if (!args.yes) {
    console.log('Tidak ada yang diubah. Jalankan ulang dengan --yes untuk menulis perubahan.');
  } else {
    await db.tx(async (tx) => {
      for (const row of stale) {
        await tx.query('UPDATE barcodes SET target_url = $2, updated_at = now() WHERE id = $1', [row.id, reviewUrlFor(row.maps_place_id)]);
      }
    });
    console.log(`${stale.length} barcode diperbarui.`);
  }
} catch (err) {
  console.error(`Gagal: ${err.message}`);
  process.exitCode = 1;
} finally {
  await ctx.db.end();
}
