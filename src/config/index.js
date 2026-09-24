import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

/** Parses an env-like object into a validated, frozen configuration object. */
export function loadConfig(env = process.env) {
  const errors = [];

  const str = (name, fallback = '') => {
    const v = env[name];
    return v === undefined || v === '' ? fallback : String(v).trim();
  };
  const int = (name, fallback, { min = -Infinity, max = Infinity } = {}) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${name} harus berupa bilangan bulat ${Number.isFinite(min) ? `>= ${min}` : ''}${Number.isFinite(max) ? ` dan <= ${max}` : ''}`.trim());
      return fallback;
    }
    return n;
  };
  const bool = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
  };
  const oneOf = (name, values, fallback) => {
    const v = str(name, fallback);
    if (!values.includes(v)) {
      errors.push(`${name} harus salah satu dari: ${values.join(', ')}`);
      return fallback;
    }
    return v;
  };

  const nodeEnv = str('NODE_ENV', 'development');
  const isProd = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  // --- APP_URL: the public base used inside QR codes. Never derived from request headers.
  let appUrl = str('APP_URL', `http://localhost:${int('PORT', 3000)}`);
  let appOrigin = '';
  try {
    const u = new URL(appUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol');
    appUrl = u.href.replace(/\/+$/, '');
    appOrigin = u.origin;
  } catch {
    errors.push('APP_URL harus berupa URL http:// atau https:// yang valid, contoh: https://barcode.domain.com');
  }

  // --- Database
  const databaseUrl = str('DATABASE_URL');
  if (!databaseUrl) errors.push('DATABASE_URL wajib diisi, contoh: postgres://user:password@localhost:5432/barcode_dinamis');
  const dbSslRaw = str('DATABASE_SSL', 'false').toLowerCase();
  const dbSsl = ['true', '1', 'require'].includes(dbSslRaw)
    ? { rejectUnauthorized: true }
    : ['no-verify', 'allow-self-signed'].includes(dbSslRaw)
      ? { rejectUnauthorized: false }
      : false;

  // --- Session / secrets
  let sessionSecret = str('SESSION_SECRET');
  if (!sessionSecret) {
    if (isProd) errors.push('SESSION_SECRET wajib diisi di production (minimal 32 karakter acak).');
    sessionSecret = 'dev-only-insecure-session-secret-change-me-0123456789';
  } else if (isProd && sessionSecret.length < 32) {
    errors.push('SESSION_SECRET terlalu pendek: gunakan minimal 32 karakter acak.');
  }

  const cookieSecureRaw = str('COOKIE_SECURE', 'auto').toLowerCase();
  const cookieSecure =
    cookieSecureRaw === 'auto' ? isProd && appUrl.startsWith('https://') : ['true', '1'].includes(cookieSecureRaw);

  // --- Reverse proxy
  const trustRaw = str('TRUST_PROXY', '0');
  let trustProxy;
  if (['0', 'false', 'no'].includes(trustRaw.toLowerCase())) trustProxy = false;
  else if (/^\d+$/.test(trustRaw)) trustProxy = Number(trustRaw);
  else if (trustRaw.toLowerCase() === 'true') trustProxy = true;
  else trustProxy = trustRaw; // e.g. "loopback, 10.0.0.0/8"

  const timezone = str('APP_TIMEZONE', 'Asia/Jakarta');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    errors.push(`APP_TIMEZONE tidak dikenali: ${timezone}`);
  }

  const codePrefix = str('CODE_PREFIX', 'BR').toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(codePrefix)) errors.push('CODE_PREFIX harus 1-6 huruf A-Z.');

  const storageDir = path.resolve(ROOT_DIR, str('STORAGE_DIR', 'storage'));

  let version = '0.0.0';
  try {
    version = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;
  } catch {
    /* package.json is optional at runtime */
  }

  const config = {
    env: nodeEnv,
    isProd,
    isTest,
    version,
    rootDir: ROOT_DIR,
    appName: str('APP_NAME', 'Dynamic Barcode'),
    appUrl,
    appOrigin,
    host: str('HOST', isProd ? '0.0.0.0' : '127.0.0.1'),
    port: int('PORT', 3000, { min: 1, max: 65535 }),
    timezone,
    trustProxy,

    db: {
      url: databaseUrl,
      ssl: dbSsl,
      poolMax: int('DATABASE_POOL_MAX', 10, { min: 1, max: 200 }),
      statementTimeoutMs: int('DATABASE_STATEMENT_TIMEOUT_MS', 20000, { min: 0 }),
    },

    session: {
      secret: sessionSecret,
      cookieName: str('SESSION_COOKIE_NAME', 'bdms.sid'),
      cookieSecure,
      ttlHours: int('SESSION_TTL_HOURS', 8, { min: 1, max: 24 * 30 }),
    },

    codes: {
      prefix: codePrefix,
      mode: oneOf('CODE_MODE', ['sequential', 'random'], 'sequential'),
    },

    qr: {
      errorCorrection: oneOf('QR_ERROR_CORRECTION', ['L', 'M', 'Q', 'H'], 'Q'),
      margin: int('QR_MARGIN', 4, { min: 0, max: 16 }),
      pngSize: int('QR_PNG_SIZE', 1024, { min: 128, max: 4096 }),
    },

    redirect: {
      cacheTtlMs: int('REDIRECT_CACHE_TTL_MS', 0, { min: 0, max: 600000 }),
      rateLimit: {
        windowMs: int('REDIRECT_RATE_LIMIT_WINDOW_SEC', 60, { min: 1 }) * 1000,
        max: int('REDIRECT_RATE_LIMIT_MAX', 600, { min: 1 }),
      },
      notFoundRateLimit: {
        windowMs: int('REDIRECT_404_RATE_LIMIT_WINDOW_SEC', 60, { min: 1 }) * 1000,
        max: int('REDIRECT_404_RATE_LIMIT_MAX', 30, { min: 1 }),
      },
      maxPendingScanWrites: int('SCAN_MAX_PENDING_WRITES', 2000, { min: 10 }),
    },

    loginRateLimit: {
      windowMs: int('LOGIN_RATE_LIMIT_WINDOW_MIN', 15, { min: 1 }) * 60 * 1000,
      max: int('LOGIN_RATE_LIMIT_MAX', 10, { min: 1 }),
    },

    publicPageRateLimit: {
      max: int('PUBLIC_PAGE_RATE_LIMIT_MAX', 120, { min: 1 }), // requests per minute per IP for the login page
    },

    // Public edit links (/e/{token}): no login, so the endpoint is rate limited three ways.
    editLink: {
      rateLimit: { windowMs: 60_000, max: int('EDIT_LINK_RATE_LIMIT_MAX', 60, { min: 1 }) }, // every request, per IP per minute
      invalidRateLimit: { windowMs: 10 * 60_000, max: int('EDIT_LINK_INVALID_RATE_LIMIT_MAX', 10, { min: 1 }) }, // unknown links, per IP per 10 minutes
      saveRateLimit: { windowMs: 60 * 60_000, max: int('EDIT_LINK_SAVE_RATE_LIMIT_MAX', 30, { min: 1 }) }, // saves, per link per hour
    },

    privacy: {
      anonymizeIp: bool('IP_ANONYMIZE', false),
    },

    imports: {
      maxRows: int('IMPORT_MAX_ROWS', 20000, { min: 1 }),
      maxUploadBytes: int('IMPORT_MAX_UPLOAD_MB', 5, { min: 1, max: 100 }) * 1024 * 1024,
    },

    bcryptRounds: int('BCRYPT_ROUNDS', 12, { min: 4, max: 15 }),

    // true = apply pending database migrations at start-up (handy for containers / PaaS).
    autoMigrate: bool('AUTO_MIGRATE', false),

    storageDir,
    logs: {
      level: str('LOG_LEVEL', isProd ? 'info' : 'debug'),
      toFile: bool('LOG_TO_FILE', isProd),
      dir: path.resolve(storageDir, 'logs'),
    },
  };

  if (errors.length) {
    const err = new Error(`Konfigurasi (.env) tidak valid:\n  - ${errors.join('\n  - ')}`);
    err.name = 'ConfigError';
    throw err;
  }
  return Object.freeze(config);
}

/** Loads .env (if any) and returns the configuration for the current process. */
export function loadConfigFromEnvFile() {
  dotenv.config({ path: process.env.ENV_FILE || path.join(ROOT_DIR, '.env'), quiet: true });
  return loadConfig(process.env);
}
