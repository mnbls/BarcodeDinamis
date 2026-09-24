// Runs every tests/**/*.test.js with the built-in Node test runner:  npm test
//
// The files are listed here instead of passing the glob "tests/**/*.test.js" to `node --test`, because only
// Node 21+ expands globs itself. This way `npm test` behaves the same on every Node this project supports
// (20.11+). Extra arguments go straight to the runner, e.g.  npm test -- --test-name-pattern "printed QR"
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const testsDir = path.resolve(import.meta.dirname, '..', 'tests');
const files = [];

function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.test.js')) files.push(full);
  }
}

collect(testsDir);
files.sort();

// Tests share one database and truncate its tables, so they run one file at a time.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
