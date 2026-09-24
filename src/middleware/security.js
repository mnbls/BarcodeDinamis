import helmet from 'helmet';

/**
 * Security headers. The CSP allows only same-origin scripts and styles (no inline scripts, no CDNs).
 * Inline style *attributes* are permitted because a few components size themselves with
 * style="width: 40%" (bars, progress); inline <script> and <style> elements stay blocked.
 */
export function securityHeaders(config) {
  const helmetMiddleware = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
    // 180 days; deliberately not "includeSubDomains" (the app may live on an apex domain shared with other sites).
    hsts: config.isProd && config.appUrl.startsWith('https://') ? { maxAge: 15_552_000, includeSubDomains: false } : false,
  });

  return (req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    helmetMiddleware(req, res, next);
  };
}

/** Admin pages must never be cached by browsers or proxies (back button after logout, shared computers). */
export function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
