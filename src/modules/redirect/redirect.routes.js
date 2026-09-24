import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { isUnguessableCode, normalizeCode } from '../../lib/codes.js';
import { redirectLimiters } from '../../middleware/rate-limit.js';
import { needsHandoffPage } from '../barcodes/targets.js';
import { getEditToken, resolveForRedirect } from '../barcodes/barcodes.repo.js';

const PAGES = {
  'not-found': { status: 404, title: 'Barcode Tidak Ditemukan', message: 'Kode yang Anda pindai tidak terdaftar. Periksa kembali barcode tersebut atau hubungi pihak yang membagikannya.' },
  inactive: { status: 403, title: 'Barcode Tidak Aktif', message: 'Barcode ini sedang dinonaktifkan oleh pengelolanya. Silakan hubungi pihak yang membagikannya.' },
  expired: { status: 410, title: 'Barcode Sudah Tidak Berlaku', message: 'Masa berlaku barcode ini sudah berakhir. Silakan hubungi pihak yang membagikannya untuk barcode terbaru.' },
  // The barcode exists and is switched on, but nobody has filled in its destination yet. Not an error, so 200:
  // it must not count against the "unknown code" limiter (people scan freshly printed stickers over and over).
  pending: { status: 200, title: 'Barcode Belum Diisi', message: 'Tujuan barcode ini belum diatur oleh pemiliknya. Silakan coba lagi nanti atau hubungi pihak yang membagikannya.' },
};

const PREFETCH = /prefetch|preview/i;

/**
 * Public redirect endpoint: GET /b/{code}.
 *
 * It is mounted BEFORE sessions, body parsers, CSRF and request logging, so a scan costs one indexed
 * lookup and nothing else. No internal information (database ids, target of an inactive code, errors)
 * ever reaches the visitor.
 *
 *   1. look the code up         (optional in-memory cache)
 *   2. active?                  -> else "Barcode Tidak Aktif"
 *   3. expired?                 -> else "Barcode Sudah Tidak Berlaku"
 *   4. destination filled in?   -> else the card is waiting for its owner: redirect to its activation page (its edit
 *                                  link), or "Barcode Belum Diisi" when that is not allowed (see openActivation)
 *   5. redirect (302, never cached), THEN record the scan without delaying the visitor
 */
export function createRedirectRouter(ctx) {
  const { db, cache, recorder, logger } = ctx;
  const router = Router();
  const limiters = redirectLimiters(ctx.config);

  function showPage(res, kind, code) {
    const page = PAGES[kind];
    res
      .status(page.status)
      .set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' })
      .render('errors/barcode', { ...page, kind, code: kind === 'not-found' ? null : code });
  }

  /**
   * A barcode without a destination is a card that waits for its owner. Scanning it takes the scanner to the card's own
   * activation page (/e/{token}, the edit link), where the Google Maps link is entered; nothing has to be handed over
   * separately. That page is a secret address, so this happens only when
   *   - the code cannot be guessed (isUnguessableCode): otherwise anybody could count through BR-000001, BR-000002, ... and
   *     collect the address of every card that has not been activated yet. Codes of such cards are random by construction;
   *   - the barcode still has an edit link (an admin may have revoked it).
   * In every other case the scanner gets the plain "Belum Diisi" page and learns nothing. Once the destination is filled in,
   * the scan goes there and the secret never leaves the server again. Not a scan: nothing is recorded.
   */
  async function openActivation(res, barcode, code) {
    if (!isUnguessableCode(code)) return showPage(res, 'pending', code);
    const token = await getEditToken(db, barcode.id); // never cached: replacing or revoking the link works at once
    if (!token) return showPage(res, 'pending', code);
    res.set({ 'Cache-Control': 'no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    return res.redirect(302, `/e/${token}`);
  }

  router.get('/b/:code', limiters, async (req, res, next) => {
    try {
      const code = normalizeCode(req.params.code);
      if (!code) return showPage(res, 'not-found'); // malformed: do not even query the database

      let barcode = cache.get(code);
      if (barcode === undefined) {
        const generation = cache.generation;
        barcode = await resolveForRedirect(db, code);
        if (barcode) cache.set(code, barcode, generation);
      }

      if (!barcode) return showPage(res, 'not-found');
      if (barcode.status !== 'active') return showPage(res, 'inactive', code);
      if (barcode.expired_at && barcode.expired_at.getTime() <= Date.now()) return showPage(res, 'expired', code);
      if (barcode.target_url === null) return await openActivation(res, barcode, code);

      res.set({ 'Cache-Control': 'no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow' });

      if (needsHandoffPage(barcode.target_url)) {
        // mailto:/tel: are not reliably followed by browsers as HTTP redirects: hand off through a tiny page.
        res.status(200).render('errors/handoff', { target: barcode.target_url });
      } else {
        res.redirect(302, barcode.target_url);
      }

      // Crawlers' HEAD requests and browser prefetches are not scans.
      const purpose = `${req.get('sec-purpose') ?? ''} ${req.get('purpose') ?? ''} ${req.get('x-moz') ?? ''}`;
      if (req.method !== 'HEAD' && !PREFETCH.test(purpose)) {
        recorder.record({
          barcodeId: barcode.id,
          ip: req.ip,
          userAgent: req.get('user-agent'),
          referer: req.get('referer'),
        });
      }
      return undefined;
    } catch (err) {
      // This route runs before request logging, so give failures an id that support can search for.
      req.id ??= randomUUID();
      res.setHeader('X-Request-Id', req.id);
      logger.error({ err, code: req.params.code, reqId: req.id }, 'redirect lookup failed');
      return next(err);
    }
  });

  return router;
}
