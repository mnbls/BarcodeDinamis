import compression from 'compression';
import express from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pinoHttp from 'pino-http';
import { attachUser } from './middleware/auth.js';
import { csrfToken, csrfVerify } from './middleware/csrf.js';
import { createErrorHandlers } from './middleware/errors.js';
import { flash } from './middleware/flash.js';
import { securityHeaders } from './middleware/security.js';
import { createSessionMiddleware } from './middleware/session.js';
import { createAdminRouter } from './modules/admin/admin.routes.js';
import { redactUrl } from './lib/redact.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createEditLinkRouter } from './modules/edit-link/edit-link.routes.js';
import { createImportRouter } from './modules/imports/imports.routes.js';
import { createPublicRouter } from './modules/public/public.routes.js';
import { createRedirectRouter } from './modules/redirect/redirect.routes.js';
import { PUBLIC_DIR, setupViews } from './views.js';

/**
 * Assembles the Express application. The order below is deliberate:
 *
 *   static assets  ->  security headers  ->  /b/{code} redirect (no session, no body parsing, no logging)
 *   ->  request logging (edit-link secrets masked)  ->  /e/{token} public edit links (no session, no CSRF:
 *   the secret in the URL is the credential; parses its own tiny body)
 *   ->  body parsing  ->  session  ->  user  ->  CSRF token  ->  flash
 *   ->  /admin/import (verifies CSRF itself, after multipart parsing)  ->  CSRF verification
 *   ->  public pages, login, admin  ->  404  ->  error handler
 */
export function createApp(ctx) {
  const { config, logger } = ctx;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  setupViews(app, config);

  // Static assets: cached hard in production, cache-busted through ?v=<hash of css/js>.
  app.use(
    '/assets',
    express.static(PUBLIC_DIR, { maxAge: config.isProd ? '30d' : 0, immutable: config.isProd, index: false, dotfiles: 'ignore' }),
  );

  // Browsers ask for /favicon.ico regardless of <link rel="icon">: answer with the SVG icon instead of a 404.
  app.get('/favicon.ico', (req, res) => {
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').sendFile(path.join(PUBLIC_DIR, 'img', 'favicon.svg'));
  });

  app.use(securityHeaders(config));
  app.use(compression());

  // The redirect system: the busiest endpoint, deliberately kept as light as possible.
  app.use(createRedirectRouter(ctx));

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => req.url === '/healthz' },
      // Keep access logs small: no query strings (search terms, tokens), and edit-link secrets masked.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: redactUrl(req.url) }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // Public edit links: before the session/CSRF stack on purpose (see the module for why that is safe).
  app.use('/e', createEditLinkRouter(ctx));

  app.use(express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 6000 }));

  const { middleware: sessionMiddleware } = createSessionMiddleware(ctx);
  app.use(sessionMiddleware);
  app.use(attachUser(ctx));
  app.use(csrfToken());
  app.use(flash());
  app.use((req, res, next) => {
    res.locals.currentPath = req.path;
    next();
  });

  app.use('/admin/import', createImportRouter(ctx));

  app.use(csrfVerify());

  app.use(createPublicRouter(ctx));
  app.use(createAuthRouter(ctx));
  app.use('/admin', createAdminRouter(ctx));

  const { notFoundHandler, errorHandler } = createErrorHandlers(ctx);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
