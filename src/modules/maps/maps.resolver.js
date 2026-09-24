import { buildPlaceId, extractLocationIds, extractPlaceId, isGoogleHost, parseMapsLink, reviewUrlFor } from '../../lib/google-maps.js';

const MAX_HOPS = 5; // short link -> at most five redirects
const TOTAL_BUDGET_MS = 10_000; // ...and never more than this in total, whatever the per-request timeout is

// Some Google endpoints answer differently to unknown clients; a plain browser-like agent is the least surprising.
const REQUEST_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; DynamicBarcode/1.0)',
  accept: 'text/html,*/*;q=0.8',
  'accept-language': 'id,en;q=0.8',
};

const ERRORS = {
  unreachable: 'Link pendek tidak bisa dibuka saat ini. Coba lagi sebentar lagi, atau tempel link panjang dari google.com/maps.',
  notMaps: 'Link pendek ini tidak mengarah ke lokasi di Google Maps. Salin ulang lewat tombol Bagikan di Google Maps.',
  noLocation: 'ID lokasi tidak ditemukan di link ini. Buka lokasinya di Google Maps, pilih Bagikan, lalu Salin link.',
};

/**
 * Turns a pasted Google Maps link into { placeId, reviewUrl, sourceUrl }.
 *
 * Long links are read directly. Short links (goo.gl/maps, maps.app.goo.gl, g.page) are expanded here, on the server:
 * one GET per hop WITHOUT following redirects automatically, only the Location header is read and the response body is
 * dropped unread. Every hop must stay on a Google domain, at most five hops. Nothing else is ever requested, which is
 * what keeps a server-side fetch of user-supplied links safe.
 *
 * `fetch` is injectable so tests never touch the network.
 */
export function createMapsResolver({ fetch: fetchImpl = globalThis.fetch, timeoutMs = 4000, logger } = {}) {
  const failed = (reason, message, host) => {
    logger?.warn({ reason, host }, 'maps link could not be resolved');
    return { ok: false, error: message };
  };

  /** One hop of a short link. Returns { url } (the next address) or { error } (a message for the form). */
  async function expandOnce(url, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { error: failed('deadline', ERRORS.unreachable, url.hostname).error };

    let response;
    try {
      response = await fetchImpl(url.href, {
        method: 'GET',
        redirect: 'manual', // we read the Location header ourselves, after checking where it leads
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
      });
    } catch (err) {
      return { error: failed(err?.name ?? 'fetch-error', ERRORS.unreachable, url.hostname).error };
    }
    // Only the headers matter: never download the page behind the link.
    try {
      await response.body?.cancel();
    } catch {
      /* nothing to clean up */
    }

    if (response.status < 300 || response.status > 399) return { error: failed(`status-${response.status}`, ERRORS.notMaps, url.hostname).error };
    const location = response.headers.get('location');
    if (!location) return { error: failed('no-location', ERRORS.notMaps, url.hostname).error };

    let next;
    try {
      next = new URL(location, url); // Location may be relative
    } catch {
      return { error: failed('bad-location', ERRORS.notMaps, url.hostname).error };
    }
    if ((next.protocol !== 'https:' && next.protocol !== 'http:') || next.username || next.password || next.port) {
      return { error: failed('bad-target', ERRORS.notMaps, url.hostname).error };
    }
    if (!isGoogleHost(next.hostname)) return { error: failed('leaves-google', ERRORS.notMaps, url.hostname).error };
    next.protocol = 'https:';
    return { url: next };
  }

  return {
    async resolve(rawLink) {
      const parsed = parseMapsLink(rawLink);
      if (!parsed.ok) return { ok: false, error: parsed.error };

      const deadline = Date.now() + TOTAL_BUDGET_MS;
      let current = parsed.url;
      let isShort = parsed.kind === 'short';

      for (let hop = 0; ; hop += 1) {
        const ids = extractLocationIds(current.href);
        if (ids) {
          const placeId = buildPlaceId(ids.high, ids.low);
          return { ok: true, placeId, reviewUrl: reviewUrlFor(placeId), sourceUrl: parsed.href };
        }
        // No location id, but the address may already carry the Place ID (a Business Profile review link).
        const direct = extractPlaceId(current.href);
        if (direct) return { ok: true, placeId: direct, reviewUrl: reviewUrlFor(direct), sourceUrl: parsed.href };
        if (!isShort) return { ok: false, error: ERRORS.noLocation }; // a long link without a location id (e.g. only coordinates)
        if (hop >= MAX_HOPS) return failed('too-many-hops', ERRORS.notMaps, current.hostname);

        const step = await expandOnce(current, deadline);
        if (step.error) return { ok: false, error: step.error };
        current = step.url;
        // Still a short link (goo.gl, maps.app.goo.gl, g.page)? Keep expanding. A google.<tld> address is read as it is.
        isShort = current.hostname === 'goo.gl' || current.hostname.endsWith('.goo.gl') || current.hostname === 'g.page';
      }
    },
  };
}
