// From a Google Maps link to a "write a review" link. A person pastes any Maps link of a place; the system keeps the
// place's Place ID as the primary data and builds the review page address from it:
//
//   1. accept only Google Maps hosts                                        (parseMapsLink)
//   2. short links (goo.gl/maps, maps.app.goo.gl, g.page) are expanded on the SERVER by reading the redirect
//      header only (modules/maps/maps.resolver.js; browsers cannot do it because of CORS)
//   3. read the location id "0xAAAA:0xBBBB" from the decoded long URL         (extractLocationIds)
//   4. Place ID = base64url( 0A 12 09 | AAAA as 8 bytes little-endian | 11 | BBBB as 8 bytes little-endian )
//      (20 bytes; always starts with "ChIJ")                                (buildPlaceId)
//   5. review link = https://search.google.com/local/writereview?placeid=<Place ID>   (reviewUrlFor)
//
// The review link can always be rebuilt from the Place ID, so the link format can change later without asking anybody
// to paste their Maps link again (see scripts/rebuild-review-urls.js).
import { cleanLine } from './text.js';

export const MAPS_LINK_MAX_LENGTH = 2048;

/** The kinds of link people may paste, for hints and error messages. */
export const MAPS_HOSTS_HINT = 'google.com/maps, maps.google.*, goo.gl/maps, maps.app.goo.gl, atau g.page';

// google.com, google.de, google.co.id, google.com.au ...
const GOOGLE_TLD = '(?:com?\\.[a-z]{2}|[a-z]{2,3})';
const MAPS_GOOGLE_HOST = new RegExp(`^maps\\.google\\.${GOOGLE_TLD}$`);
const ANY_GOOGLE_HOST = new RegExp(`^(?:[a-z0-9-]+\\.)*google\\.${GOOGLE_TLD}$`);

/**
 * Where a short link may lead. Used for every redirect the server follows: it never talks to anything that is not
 * Google (that is what keeps a server-side fetch of user-supplied links from becoming an SSRF hole). Exact host
 * matching: "google.com.evil.test" and "evilgoogle.com" do not pass.
 */
export function isGoogleHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return ANY_GOOGLE_HOST.test(host) || host === 'goo.gl' || host.endsWith('.goo.gl') || host === 'g.page';
}

/** 'long' = the link itself carries the location id; 'short' = must be expanded first; null = not a Maps link we accept. */
export function classifyMapsUrl(url) {
  const host = url.hostname.toLowerCase();
  const { pathname } = url;
  const inMaps = pathname === '/maps' || pathname.startsWith('/maps/');
  if ((host === 'google.com' || host === 'www.google.com') && inMaps) return 'long';
  if (MAPS_GOOGLE_HOST.test(host)) return 'long';
  if (host === 'goo.gl' && inMaps) return 'short';
  if (host === 'maps.app.goo.gl' && pathname.length > 1) return 'short';
  if (host === 'g.page' && pathname.length > 1) return 'short';
  return null;
}

/**
 * Step 1: validates what a person pasted. Returns { ok: true, url, href, kind } where href is the normalised link
 * (https, no fragment) that is stored as the "original link", or { ok: false, error } with a message for the form.
 */
export function parseMapsLink(input) {
  const raw = cleanLine(input);
  if (!raw) return { ok: false, error: 'Link Google Maps wajib diisi.' };
  if (raw.length > MAPS_LINK_MAX_LENGTH) return { ok: false, error: `Link terlalu panjang (maksimal ${MAPS_LINK_MAX_LENGTH} karakter).` };
  if (/\s/.test(raw)) return { ok: false, error: 'Link tidak boleh mengandung spasi.' };

  // "maps.app.goo.gl/abc" without the scheme is how many people paste it.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: 'Format link tidak valid.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'Link harus diawali https://.' };
  if (url.username || url.password) return { ok: false, error: 'Link tidak boleh memuat username atau password.' };
  if (url.port) return { ok: false, error: 'Link tidak valid.' };

  const kind = classifyMapsUrl(url);
  if (!kind) return { ok: false, error: `Link harus dari Google Maps (${MAPS_HOSTS_HINT}).` };

  url.protocol = 'https:'; // Google serves all of these over https: never talk plain http
  url.hash = '';
  return { ok: true, url, href: url.href, kind };
}

/** Percent-decodes up to `rounds` times (links nested in a "continue=" parameter are encoded twice). */
export function decodeRepeatedly(text, rounds = 3) {
  let current = String(text);
  for (let i = 0; i < rounds; i += 1) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      break; // a stray "%" somewhere: keep what has been decoded so far
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

// "!1s0xAAAA:0xBBBB" (inside the data= part of a place URL) or "ftid=0xAAAA:0xBBBB" (query parameter).
// Each number is at most 16 hex digits (64 bits); anything longer is not a location id.
const LOCATION_ID = /(?:!1s|[?&]ftid=)(0x[0-9a-f]{1,16}):(0x[0-9a-f]{1,16})(?![0-9a-f])/i;

/** Step 3: { high, low } (BigInt, each below 2^64) from a Maps URL, or null when it carries no location id. */
export function extractLocationIds(url) {
  const match = LOCATION_ID.exec(decodeRepeatedly(url));
  if (!match) return null;
  const high = BigInt(match[1]);
  const low = BigInt(match[2]);
  if (high === 0n && low === 0n) return null;
  return { high, low };
}

const PLACE_ID = /^ChIJ[A-Za-z0-9_-]{23}$/;

export const isPlaceId = (value) => typeof value === 'string' && PLACE_ID.test(value);

// An address that ALREADY carries the Place ID, such as the review link that g.page/r/.../review leads to
// (".../writereview?placeid=ChIJ...") or a place_id: query. Place IDs are case-sensitive: no "i" flag.
const PLACE_ID_IN_URL = /(?:[?&](?:placeid|place_id|query_place_id)=|place_id:)(ChIJ[A-Za-z0-9_-]{23})(?![A-Za-z0-9_-])/;

/**
 * Fallback for step 3: the Place ID itself when the URL already contains one, else null. Only tried when the URL has no
 * "0xAAAA:0xBBBB" location id, so the documented recipe always wins for links that have both.
 */
export function extractPlaceId(url) {
  const match = PLACE_ID_IN_URL.exec(decodeRepeatedly(url));
  return match ? match[1] : null;
}

/** Step 4: 20 bytes  0A 12 09 | high (8 bytes, little-endian) | 11 | low (8 bytes, little-endian), as base64url without padding. */
export function buildPlaceId(high, low) {
  const bytes = Buffer.alloc(20);
  bytes[0] = 0x0a;
  bytes[1] = 0x12;
  bytes[2] = 0x09;
  bytes.writeBigUInt64LE(BigInt(high), 3);
  bytes[11] = 0x11;
  bytes.writeBigUInt64LE(BigInt(low), 12);
  return bytes.toString('base64url');
}

/** The reverse of buildPlaceId (tests, diagnostics). Returns { high, low } or null for anything that is not such a Place ID. */
export function parsePlaceId(placeId) {
  if (!isPlaceId(placeId)) return null;
  const bytes = Buffer.from(placeId, 'base64url');
  if (bytes.length !== 20 || bytes[0] !== 0x0a || bytes[1] !== 0x12 || bytes[2] !== 0x09 || bytes[11] !== 0x11) return null;
  return { high: bytes.readBigUInt64LE(3), low: bytes.readBigUInt64LE(12) };
}

/** Step 5. The ONE place that knows the format of the review link: change it here and run scripts/rebuild-review-urls.js. */
export const reviewUrlFor = (placeId) => `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
