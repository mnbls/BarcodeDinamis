import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import pino from 'pino';

const require = createRequire(import.meta.url);

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'currentPassword',
  'newPassword',
];

/**
 * pino logger: JSON to stdout (+ optional file), pretty output in development when pino-pretty
 * (a devDependency) is installed. Silent under test.
 */
export function createLogger(config) {
  const level = config.isTest ? 'silent' : config.logs.level;
  const base = { level, redact: { paths: REDACT, censor: '[redacted]' }, base: { app: 'dynamic-barcode' } };

  const streams = [];
  if (!config.isProd && !config.isTest) {
    try {
      const pretty = require('pino-pretty');
      streams.push({ stream: pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app' }) });
    } catch {
      streams.push({ stream: process.stdout });
    }
  } else {
    streams.push({ stream: process.stdout });
  }

  if (config.logs.toFile && !config.isTest) {
    mkdirSync(config.logs.dir, { recursive: true });
    streams.push({ stream: pino.destination({ dest: path.join(config.logs.dir, 'app.log'), mkdir: true, sync: false }) });
  }

  return pino(base, streams.length === 1 ? streams[0].stream : pino.multistream(streams));
}
