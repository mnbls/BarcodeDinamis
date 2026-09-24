// Characters that have no business in names/URLs/user agents: C0/C1 controls, line/paragraph
// separators, zero-width spaces, BOM and bidirectional overrides (used for text spoofing).
// Built from numeric code point ranges on purpose: invisible characters must never appear
// literally in source files (they are impossible to review).
const UNSAFE_RANGES = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], // C0 (except tab/LF/CR), DEL, C1
  [0x2028, 0x2029], // line / paragraph separator
  [0x200b, 0x200b], [0x200e, 0x200f], // zero-width space, LRM/RLM
  [0x202a, 0x202e], [0x2066, 0x2069], // bidirectional embeddings/overrides/isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];
const UNSAFE_CHARS = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => String.fromCodePoint(a) + (a === b ? '' : `-${String.fromCodePoint(b)}`)).join('')}]`, 'g');

/** Single-line text: normalised, control characters removed, whitespace collapsed. */
export function cleanLine(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFC')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(UNSAFE_CHARS, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Multi-line text (descriptions): keeps line breaks, removes everything unsafe. */
export function cleanMultiline(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(UNSAFE_CHARS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cuts a string to `max` characters (code points), for untrusted headers such as User-Agent. */
export function truncate(value, max) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

/** Sanitises an untrusted header value before it is stored. */
export function cleanHeader(value, max) {
  if (!value) return null;
  const s = truncate(String(value).replace(UNSAFE_CHARS, '').replace(/[\r\n\t]+/g, ' ').trim(), max);
  return s || null;
}

/** Escapes LIKE/ILIKE wildcards so user input is matched literally (default escape char is backslash). */
export function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

/** Undoes the leading apostrophe that CSV export adds to defuse spreadsheet formulas. */
export function stripFormulaGuard(value) {
  return String(value).replace(/^'(?=[=+\-@\t\r])/, '');
}
