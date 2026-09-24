import { randomInt } from 'node:crypto';

// No 0/1/I/L/O so printed codes cannot be misread.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const RANDOM_LENGTH = 8;

/** BR-000001. Grows past 6 digits automatically (BR-1000000). */
export function formatSequentialCode(prefix, n) {
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

/**
 * BR-7K3M9QXT (cryptographically random, ~8.5e11 combinations). Always contains a letter (about 1 draw in 50,000 is
 * all digits and is drawn again): that is how isUnguessableCode() tells a random code from a sequential one.
 */
export function generateRandomCode(prefix, length = RANDOM_LENGTH) {
  let out;
  do {
    out = '';
    for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  } while (!/[A-Z]/.test(out));
  return `${prefix}-${out}`;
}

/**
 * True for a code that cannot be found by counting: a random one (BR-7K3M9QXT), never a sequential one (BR-000037).
 * A card that still waits for its owner hands its activation link to whoever scans it (redirect.routes.js), so only a
 * code like this may do that: with a guessable code anyone could walk through BR-000001, BR-000002, ... and collect them.
 */
export function isUnguessableCode(code) {
  const match = /^[A-Z]{1,6}-([A-Z0-9]{8,})$/.exec(String(code ?? ''));
  return match !== null && /[A-Z]/.test(match[1]);
}

/** Shape check used before touching the database: PREFIX-XXXXXX. Returns the upper-cased code or null. */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase();
  return /^[A-Z]{1,6}-[A-Z0-9]{3,20}$/.test(code) ? code : null;
}

/**
 * Reserves `count` codes. Sequential mode draws from the database sequence (atomic, never reused);
 * random mode draws from the CSPRNG (callers must handle the astronomically unlikely collision by
 * relying on the UNIQUE index and asking for new codes). `mode` overrides CODE_MODE for this call.
 */
export async function allocateCodes(db, { codes }, count, { mode = codes.mode } = {}) {
  if (count <= 0) return [];
  if (mode === 'random') {
    const set = new Set();
    while (set.size < count) set.add(generateRandomCode(codes.prefix));
    return [...set];
  }
  const rows = await db.rows("SELECT nextval('barcode_code_seq') AS n FROM generate_series(1, $1::int)", [count]);
  return rows.map((r) => formatSequentialCode(codes.prefix, r.n));
}
