import { createDb } from './db/pool.js';
import { createLogger } from './lib/logger.js';
import { createQrService } from './lib/qr.js';
import { createScanRecorder } from './modules/analytics/scans.recorder.js';
import { createMapsResolver } from './modules/maps/maps.resolver.js';
import { createRedirectCache } from './modules/redirect/redirect.cache.js';

/**
 * Builds the shared dependencies once (database, logger, QR generator, Google Maps link resolver, scan recorder,
 * redirect cache). Everything else receives this object, which keeps modules decoupled and easy to test
 * (tests pass their own `maps` so that no test ever contacts Google).
 */
export function createContext(config, overrides = {}) {
  const logger = overrides.logger ?? createLogger(config);
  const db = overrides.db ?? createDb(config, logger);
  const cache = createRedirectCache(config.redirect.cacheTtlMs);
  const recorder = createScanRecorder({ db, config, logger });
  const qr = createQrService(config);
  const maps = overrides.maps ?? createMapsResolver({ timeoutMs: config.maps.timeoutMs, logger });

  return {
    config,
    logger,
    db,
    cache,
    recorder,
    qr,
    maps,

    /** Graceful shutdown: finish pending scan writes, then release the connection pool. */
    async close() {
      await recorder.idle();
      await db.end();
    },
  };
}
