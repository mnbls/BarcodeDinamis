import { Router } from 'express';
import { safeNext } from '../../middleware/auth.js';
import { loginLimiter, publicPageLimiter } from '../../middleware/rate-limit.js';
import { authenticate } from './auth.service.js';

const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
const save = (req) => new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));

export function createAuthRouter(ctx) {
  const router = Router();

  router.get('/login', publicPageLimiter(ctx.config), (req, res) => {
    if (req.user) return res.redirect('/admin');
    return res.render('pages/login', { title: 'Login Admin', form: { identifier: '' }, next: safeNext(req.query.next), error: null });
  });

  router.post('/login', loginLimiter(ctx.config), async (req, res) => {
    const identifier = String(req.body.identifier ?? '');
    const password = String(req.body.password ?? '');
    const next = safeNext(req.body.next);

    const user = await authenticate(ctx, identifier, password);
    if (!user) {
      ctx.logger.warn({ ip: req.ip }, 'failed login attempt');
      return res.status(401).render('pages/login', {
        title: 'Login Admin',
        form: { identifier: identifier.slice(0, 190) },
        next,
        error: 'Username/email atau password salah.',
      });
    }

    // New session id on privilege change (prevents session fixation); the CSRF token is renewed too.
    await regenerate(req);
    req.session.userId = user.id;
    req.session.pwdAt = user.password_changed_at.getTime();
    await save(req);
    ctx.logger.info({ userId: user.id }, 'login');
    return res.redirect(next);
  });

  // Logout is a POST (with CSRF token) so a third-party page cannot sign the admin out.
  router.post('/logout', async (req, res) => {
    const userId = req.user?.id;
    await regenerate(req); // drops the authenticated session entirely, starts an anonymous one
    req.flash('info', 'Anda telah keluar.');
    if (userId) ctx.logger.info({ userId }, 'logout');
    res.redirect('/login');
  });

  return router;
}
