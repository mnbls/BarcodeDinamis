import { notFound } from '../../lib/http-errors.js';
import { isEditToken } from '../../lib/edit-token.js';
import { anonymizeIp, normalizeIp } from '../../lib/ip.js';
import * as repo from '../barcodes/barcodes.repo.js';
import { validateTarget } from '../barcodes/barcodes.validation.js';

/**
 * The barcode behind an edit link, or null for anything that is not a live link (malformed, unknown,
 * revoked or replaced). Bad input never reaches the database.
 */
export async function findBarcodeByLink(ctx, token) {
  if (!isEditToken(token)) return null;
  return repo.findByEditToken(ctx.db, token);
}

/**
 * Saves the destination on behalf of somebody who is NOT signed in and only holds the edit link.
 *
 * The link is the whole authorisation, so this is deliberately narrow: it can change the destination (type,
 * value, optional extra) of that one barcode and nothing else. Name, description, status, expiry, statistics
 * and deletion are out of reach, and everything is validated by the same rules as in the admin form.
 * The row is locked while it is read and written, so two people editing at once cannot interleave and
 * produce a wrong history. Every change that alters the URL is written to barcode_history with the
 * source "edit_link" and the caller's IP (anonymised when IP_ANONYMIZE is on).
 *
 * Throws a 404 for a dead link. Returns { ok: true, changed, barcode } or { ok: false, errors, barcode }.
 */
export async function saveTargetViaLink(ctx, token, input, { ip } = {}) {
  if (!isEditToken(token)) throw notFound();

  const outcome = await ctx.db.tx(async (tx) => {
    const current = await repo.findByEditToken(tx, token, { forUpdate: true });
    if (!current) throw notFound();

    // A destination is required here (no allowEmpty): the person cannot turn a filled barcode back into a blank one.
    const { targetType, targetUrl, errors } = validateTarget(input, { appOrigin: ctx.config.appOrigin });
    if (Object.keys(errors).length) return { ok: false, errors, barcode: current };

    const urlChanged = targetUrl !== current.target_url;
    const changed = urlChanged || targetType !== current.target_type;
    if (changed) await repo.updateTarget(tx, current.id, { targetType, targetUrl });
    if (urlChanged) {
      const address = normalizeIp(ip);
      await repo.insertHistory(tx, {
        barcodeId: current.id,
        oldUrl: current.target_url,
        newUrl: targetUrl,
        changedBy: null,
        changedVia: 'edit_link',
        changedIp: ctx.config.privacy.anonymizeIp ? anonymizeIp(address) : address,
      });
    }
    return { ok: true, changed, barcode: current };
  });

  if (outcome.ok && outcome.changed) {
    ctx.cache.invalidate(outcome.barcode.code);
    // The code, never the link itself, goes into the log.
    ctx.logger.info({ code: outcome.barcode.code }, 'destination changed through the edit link');
  }
  return outcome;
}
