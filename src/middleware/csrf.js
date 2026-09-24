import { randomBytes, timingSafeEqual } from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const ANONYMOUS_SESSION_MS = 60 * 60 * 1000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export class CsrfError extends Error {
  constructor() {
    super('Token keamanan formulir tidak valid atau sudah kedaluwarsa.');
    this.name = 'CsrfError';
    this.status = 403;
    this.code = 'EBADCSRFTOKEN';
    this.expose = true;
  }
}

/**
 * Synchroniser-token CSRF protection. The token lives in the server-side session and must come back
 * in `_csrf` (HTML forms) or `X-CSRF-Token` (fetch) on every state-changing request. Cross-site requests
 * announced by the browser (Sec-Fetch-Site: cross-site) are rejected outright, and the session cookie is
 * SameSite=Lax as a further layer.
 *
 * Split in two so a multipart upload route can verify AFTER its body was parsed:
 *   csrfToken()   - issues the token and exposes it to views (runs for every request)
 *   csrfVerify()  - rejects unsafe requests without a valid token
 */
export function csrfToken() {
  return (req, res, next) => {
    if (!req.session) return next(new Error('Session middleware must run before CSRF protection.'));
    // Lazy: templates call {{ csrf() }}. Pages without forms (landing page, crawlers) never create a
    // session row, because express-session only stores sessions that were modified.
    res.locals.csrf = () => {
      if (!req.session.csrfToken) {
        req.session.csrfToken = randomBytes(32).toString('base64url');
        // A visitor who is not signed in only needs the session for the minutes it takes to submit the
        // login form: keep such rows short-lived so crawlers cannot pile up long-lived sessions.
        if (!req.session.userId) req.session.cookie.maxAge = ANONYMOUS_SESSION_MS;
      }
      return req.session.csrfToken;
    };
    return next();
  };
}

export function verifyCsrf(req, next) {
  if (req.get('sec-fetch-site') === 'cross-site') return next(new CsrfError());
  const supplied = req.body?._csrf || req.get('x-csrf-token');
  if (!supplied || !req.session?.csrfToken || !safeEqual(supplied, req.session.csrfToken)) return next(new CsrfError());
  return next();
}

export function csrfVerify() {
  return (req, res, next) => (SAFE_METHODS.has(req.method) ? next() : verifyCsrf(req, next));
}
