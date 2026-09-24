import { loadConfigFromEnvFile } from '../../src/config/index.js';
import { createContext } from '../../src/context.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child() { return silent; }, flush() {} };

/** Loads .env and builds the same context the web app uses (with a quiet logger) for CLI scripts. */
export function bootstrap() {
  const config = loadConfigFromEnvFile();
  const ctx = createContext(config, { logger: silent });
  return { config, ctx, db: ctx.db };
}

/** Parses `--key value`, `--key=value` and bare `--flag` arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[(i += 1)];
    else out[arg.slice(2)] = true;
  }
  return out;
}
