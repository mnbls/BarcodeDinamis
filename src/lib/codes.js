import { randomInt } from 'node:crypto';

// No 0/1/I/L/O so printed codes cannot be misread.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const RANDOM_LENGTH = 8;

/** BR-000001. Grows past 6 digits automatically (BR-1000000). */
export function formatSequentialCode(prefix, n) {
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

/** BR-7K3M9QXT (cryptographically random, ~8.5e11 combinations). */
export function generateRandomCode(prefix, length = RANDOM_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${out}`;
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
 * relying on the UNIQUE index and asking for new codes).
 */
export async function allocateCodes(db, { codes }, count) {
  if (count <= 0) return [];
  if (codes.mode === 'random') {
    const set = new Set();
    while (set.size < count) set.add(generateRandomCode(codes.prefix));
    return [...set];
  }
  const rows = await db.rows("SELECT nextval('barcode_code_seq') AS n FROM generate_series(1, $1::int)", [count]);
  return rows.map((r) => formatSequentialCode(codes.prefix, r.n));
}
