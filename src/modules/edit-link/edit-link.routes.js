import express, { Router } from 'express';
import { editLinkLimiters } from '../../middleware/rate-limit.js';
import { parseTarget } from '../barcodes/targets.js';
import * as service from './edit-link.service.js';

// ?saved=1|0 after a redirect. Only these two values can ever reach the template.
const SAVED_NOTICE = new Map([['1', 'yes'], ['0', 'same']]);

/**
 * Public edit link. Whoever holds the link can fill in or change the destination of that one barcode,
 * without an account. Two pages:
 *
 *   GET  /e/{token}        info page: QR, code, name, status, current destination, and a button to the form
 *   GET  /e/{token}/edit   form page: the destination fields only
 *   POST /e/{token}/edit   saves, then redirects to the info page (?saved=1|0); errors re-show the form (422)
 *
 * The secret is the first path segment after /e/, so every page (and its logs, see lib/redact.js) is covered.
 *
 * Mounted BEFORE sessions and CSRF (see app.js): there is no cookie to protect, so nothing here can be
 * "ridden" by another site. The secret in the URL is the credential; a page that does not hold it cannot
 * forge a request. What replaces the usual protections:
 *   - the secret is 256 random bits and every response is private (no-store, noindex, no Referer);
 *   - three rate limits (see editLinkLimiters);
 *   - a small body limit, and a narrow service that can only touch the destination;
 *   - the secret is masked in access logs (lib/redact.js).
 */
export function createEditLinkRouter(ctx) {
  const router = Router();
  const { general, invalid, save } = editLinkLimiters(ctx.config);
  const readForm = express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 });

  // Everything served here holds a secret URL or the current destination: never cache, never index.
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  });
  router.use(general, invalid);

  const deadLink = (res) =>
    res.status(404).render('errors/public', {
      status: 404,
      title: 'Link Edit Tidak Valid',
      message: 'Link ini tidak dikenali atau sudah dicabut. Minta link edit yang baru kepada pengelola barcode.',
    });

  // Page 1, the info page: what the barcode is and where it points now. Read-only; a button leads to the form.
  async function showInfo(res, token, barcode, { saved = '' } = {}) {
    res.render('pages/edit-link', {
      title: 'Info barcode',
      token,
      barcode,
      current: parseTarget(barcode.target_type, barcode.target_url),
      qrSvg: await ctx.qr.svg(barcode.code),
      saved,
    });
  }

  // Page 2, the form: only the fields for the destination. Also the page that shows validation errors.
  function showForm(res, token, barcode, { form, errors = {}, status = 200 } = {}) {
    const current = parseTarget(barcode.target_type, barcode.target_url);
    res.status(status).render('pages/edit-link-form', {
      title: barcode.target_url ? 'Ubah tujuan barcode' : 'Isi tujuan barcode',
      token,
      barcode,
      form: form ?? { target_type: barcode.target_type, target_value: current.value, target_extra: current.extra },
      errors,
    });
  }

  router.get('/:token', async (req, res) => {
    const { token } = req.params;
    const barcode = await service.findBarcodeByLink(ctx, token);
    if (!barcode) return deadLink(res);
    return showInfo(res, token, barcode, { saved: SAVED_NOTICE.get(String(req.query.saved)) ?? '' });
  });

  router.get('/:token/edit', async (req, res) => {
    const { token } = req.params;
    const barcode = await service.findBarcodeByLink(ctx, token);
    if (!barcode) return deadLink(res);
    return showForm(res, token, barcode);
  });

  // Only the form page accepts submissions: the info page (/e/{token}) has no POST route at all.
  router.post('/:token/edit', save, readForm, async (req, res) => {
    const { token } = req.params;
    let result;
    try {
      result = await service.saveTargetViaLink(ctx, token, req.body, { ip: req.ip });
    } catch (err) {
      if (err.status === 404) return deadLink(res);
      throw err;
    }
    if (!result.ok) return showForm(res, token, result.barcode, { form: req.body, errors: result.errors, status: 422 });
    return res.redirect(303, `/e/${token}?saved=${result.changed ? 1 : 0}`); // back to the info page, which confirms it
  });

  return router;
}
