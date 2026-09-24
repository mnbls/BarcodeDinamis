import { createHash } from 'node:crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const baseOptions = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
};

/** Login: limits attempts per IP + username so one attacker cannot lock out everybody. */
export function loginLimiter(config) {
  return rateLimit({
    ...baseOptions,
    windowMs: config.loginRateLimit.windowMs,
    limit: config.loginRateLimit.max,
    // Only failed attempts (status >= 400) count: a successful login (302) does not consume the budget.
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.identifier ?? '').toLowerCase().slice(0, 100)}`,
    handler: (req, res) => {
      res.status(429).render('pages/login', {
        title: 'Login Admin',
        form: { identifier: '' },
        next: '',
        error: 'Terlalu banyak percobaan login. Coba lagi beberapa menit lagi.',
      });
    },
  });
}

/** Public pages that create a session (the login form): stops crawlers from filling the session table. */
export function publicPageLimiter(config) {
  return rateLimit({
    ...baseOptions,
    windowMs: 60_000,
    limit: config.publicPageRateLimit.max,
    handler: (req, res) => plainPage(res, 429, 'Terlalu Banyak Permintaan', 'Anda mengirim terlalu banyak permintaan. Coba lagi sebentar lagi.'),
  });
}

function plainPage(res, status, title, message) {
  res.status(status).set('Retry-After', '60').render('errors/public', { status, title, message });
}

/**
 * Limiters for the public edit links (/e/{token}). There is no login here, so the endpoint defends itself:
 *  - general: every request, per IP;
 *  - invalid: only links that do not exist (what guessing looks like), per IP;
 *  - save:    only POSTs, per LINK, so even a leaked link cannot be used to flood the change history.
 * The link is hashed before it becomes a key: the secret is not kept in yet another place.
 */
export function editLinkLimiters(config) {
  const { rateLimit: general, invalidRateLimit: invalid, saveRateLimit: save } = config.editLink;
  const handler = (req, res) => plainPage(res, 429, 'Terlalu Banyak Permintaan', 'Anda mengirim terlalu banyak permintaan. Coba lagi sebentar lagi.');
  return {
    general: rateLimit({ ...baseOptions, windowMs: general.windowMs, limit: general.max, handler }),
    invalid: rateLimit({
      ...baseOptions,
      windowMs: invalid.windowMs,
      limit: invalid.max,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (req, res) => res.statusCode !== 404,
      handler,
    }),
    save: rateLimit({
      ...baseOptions,
      windowMs: save.windowMs,
      limit: save.max,
      keyGenerator: (req) => createHash('sha256').update(String(req.params.token)).digest('base64url'),
      handler,
    }),
  };
}

/**
 * Limiters for the public redirect endpoint:
 *  - general: protects the database from floods (per IP);
 *  - unknown: only counts codes that do NOT exist, which is what enumeration attempts look like,
 *    so legitimate visitors of an expired/inactive code are never throttled by it.
 */
export function redirectLimiters(config) {
  const handler = (req, res) => plainPage(res, 429, 'Terlalu Banyak Permintaan', 'Anda mengirim terlalu banyak permintaan. Coba lagi sebentar lagi.');
  const general = rateLimit({
    ...baseOptions,
    windowMs: config.redirect.rateLimit.windowMs,
    limit: config.redirect.rateLimit.max,
    handler,
  });
  const unknown = rateLimit({
    ...baseOptions,
    windowMs: config.redirect.notFoundRateLimit.windowMs,
    limit: config.redirect.notFoundRateLimit.max,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode !== 404,
    handler,
  });
  return [general, unknown];
}
