import { notFound } from '../../lib/http-errors.js';
import { isEditToken } from '../../lib/edit-token.js';
import { anonymizeIp, normalizeIp } from '../../lib/ip.js';
import * as repo from '../barcodes/barcodes.repo.js';

/**
 * The barcode behind an edit link, or null for anything that is not a live link (malformed, unknown,
 * revoked or replaced). Bad input never reaches the database.
 */
export async function findBarcodeByLink(ctx, token) {
  if (!isEditToken(token)) return null;
  return repo.findByEditToken(ctx.db, token);
}

/**
 * Saves a Google Maps link on behalf of somebody who is NOT signed in and only holds the edit link.
 *
 * The person pastes the Maps link of their place; the destination of the barcode becomes the Google review page of
 * that place (the link is validated, short links are expanded on the server, the Place ID is computed: see
 * lib/google-maps.js). Nothing else about the barcode can be changed from here: not the name, description, status,
 * expiry, statistics, and it cannot be deleted. Whatever destination the barcode had before (say a website an admin
 * entered) is replaced by the review page, and that change is recorded.
 *
 * Order matters:
 *   1. a dead link is refused first, so it can never cost an outbound request;
 *   2. Google is asked (short links only), with no lock and no transaction open, because that can take seconds;
 *   3. only then the row is locked and written, so two people saving at once cannot interleave and produce a wrong
 *      history. A change is written to barcode_history with the source "edit_link" and the caller's IP (anonymised
 *      when IP_ANONYMIZE is on).
 *
 * Throws a 404 for a dead link. Returns { ok: true, changed, barcode } or { ok: false, errors: { maps_link }, barcode }.
 */
export async function saveMapsViaLink(ctx, token, input, { ip } = {}) {
  if (!isEditToken(token)) throw notFound();
  const existing = await repo.findByEditToken(ctx.db, token);
  if (!existing) throw notFound();

  const resolved = await ctx.maps.resolve(input.maps_link);
  if (!resolved.ok) return { ok: false, errors: { maps_link: resolved.error }, barcode: existing };

  const outcome = await ctx.db.tx(async (tx) => {
    const current = await repo.findByEditToken(tx, token, { forUpdate: true });
    if (!current) throw notFound();

    const changed = current.target_type !== 'maps_review' || current.maps_place_id !== resolved.placeId || current.target_url !== resolved.reviewUrl;
    if (changed) {
      await repo.updateTarget(tx, current.id, {
        targetType: 'maps_review',
        targetUrl: resolved.reviewUrl,
        mapsPlaceId: resolved.placeId,
        mapsSourceUrl: resolved.sourceUrl,
      });
    }
    if (current.target_url !== resolved.reviewUrl) {
      const address = normalizeIp(ip);
      await repo.insertHistory(tx, {
        barcodeId: current.id,
        oldUrl: current.target_url,
        newUrl: resolved.reviewUrl,
        changedBy: null,
        changedVia: 'edit_link',
        changedIp: ctx.config.privacy.anonymizeIp ? anonymizeIp(address) : address,
      });
    }
    return { ok: true, changed, barcode: current };
  });

  if (outcome.changed) {
    ctx.cache.invalidate(outcome.barcode.code);
    // The code, never the link itself, goes into the log.
    ctx.logger.info({ code: outcome.barcode.code }, 'google maps set through the edit link');
  }
  return outcome;
}
