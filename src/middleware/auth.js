import { forbidden, unauthorized } from '../lib/http-errors.js';
import * as users from '../modules/auth/users.repo.js';

/**
 * Resolves req.user from the session on every request. A session becomes anonymous when the
 * account was disabled/removed or the password changed since login (so changing a password
 * signs out every other device).
 */
export function attachUser(ctx) {
  return async (req, res, next) => {
    const s = req.session;
    if (!s?.userId) return next();

    const user = await users.findById(ctx.db, s.userId);
    if (!user || !user.is_active || user.password_changed_at.getTime() !== s.pwdAt) {
      delete s.userId;
      delete s.pwdAt;
      return next();
    }
    req.user = user;
    res.locals.user = user;
    res.locals.canWrite = user.role === 'admin';
    next();
  };
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return next(unauthorized());
}

/** Authorisation: use on every route that changes data. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    return next();
  };
}

/** Only same-site paths inside the admin area are valid post-login destinations (no open redirect). */
export function safeNext(value) {
  if (typeof value !== 'string' || value.length > 500) return '/admin';
  if (!/^\/admin(?:[/?#]|$)/.test(value)) return '/admin';
  if (value.includes('\\') || /[\r\n]/.test(value)) return '/admin';
  return value;
}

/** Same rule for the "return to" field of list actions. */
export function safeReturn(value, fallback = '/admin/barcodes') {
  if (typeof value !== 'string' || value.length > 800) return fallback;
  if (!/^\/admin(?:[/?#]|$)/.test(value) || value.includes('\\') || /[\r\n]/.test(value)) return fallback;
  return value;
}
