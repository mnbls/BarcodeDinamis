import { Router } from 'express';

/** Landing page, health check and robots.txt. None of these need a session. */
export function createPublicRouter(ctx) {
  const router = Router();

  // The hero illustration is a real QR pointing at this very site.
  let qrSvg;
  router.get('/', async (req, res) => {
    qrSvg ??= await ctx.qr.svgOf(ctx.config.appUrl);
    res.render('pages/landing', { title: 'Dynamic Barcode Management', qrSvg });
  });

  // Used by load balancers / uptime monitors. Reveals nothing but up/down.
  router.get('/healthz', async (req, res) => {
    try {
      await ctx.db.ping();
      res.set('Cache-Control', 'no-store').json({ status: 'ok' });
    } catch (err) {
      ctx.logger.error({ err }, 'health check failed');
      res.status(503).set('Cache-Control', 'no-store').json({ status: 'unavailable' });
    }
  });

  router.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /login\nDisallow: /b/\nDisallow: /e/\n');
  });

  return router;
}
