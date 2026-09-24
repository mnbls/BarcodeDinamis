import { createApp } from './app.js';
import { loadConfigFromEnvFile } from './config/index.js';
import { createContext } from './context.js';
import { migrateUp } from './db/migrate.js';

let config;
try {
  config = loadConfigFromEnvFile();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const ctx = createContext(config);
const { logger } = ctx;

try {
  await ctx.db.ping();
} catch (err) {
  logger.fatal({ err: { message: err.message, code: err.code } }, 'Tidak dapat terhubung ke database. Periksa DATABASE_URL di .env dan pastikan PostgreSQL berjalan.');
  process.exit(1);
}

if (config.autoMigrate) {
  try {
    const applied = await migrateUp({ databaseUrl: config.db.url, ssl: config.db.ssl, log: (m) => logger.info(m) });
    logger.info({ applied }, applied.length ? 'database migrations applied' : 'database already up to date');
  } catch (err) {
    logger.fatal({ err: { message: err.message } }, 'AUTO_MIGRATE gagal; aplikasi tidak dijalankan.');
    process.exit(1);
  }
}

const app = createApp(ctx);
const server = app.listen(config.port, config.host, () => {
  logger.info(
    { port: config.port, host: config.host, env: config.env, appUrl: config.appUrl },
    `Dynamic Barcode berjalan di http://${config.host}:${config.port}`,
  );
  if (config.isProd && !config.appUrl.startsWith('https://')) {
    logger.warn('APP_URL tidak memakai https:// - QR Code yang dicetak akan mengarah ke alamat tidak aman.');
  }
  if (config.isProd && /localhost|127\.0\.0\.1/.test(config.appUrl)) {
    logger.warn('APP_URL masih localhost di production: QR Code tidak akan bisa dipindai dari perangkat lain.');
  }
});

// Keep-alive slightly above the usual reverse-proxy idle timeout (60 s) to avoid sporadic 502s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  server.close(async () => {
    try {
      await ctx.close(); // waits for pending scan writes, then closes the pool
      logger.flush?.();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  });
  server.closeIdleConnections?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandledRejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  shutdown('uncaughtException');
});
