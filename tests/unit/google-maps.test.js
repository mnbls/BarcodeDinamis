import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPlaceId,
  classifyMapsUrl,
  decodeRepeatedly,
  extractLocationIds,
  extractPlaceId,
  isGoogleHost,
  isPlaceId,
  parseMapsLink,
  parsePlaceId,
  reviewUrlFor,
} from '../../src/lib/google-maps.js';
import { createMapsResolver } from '../../src/modules/maps/maps.resolver.js';

// The example Place ID from Google's own documentation (Google Sydney) and the two numbers it is made of.
const SYDNEY = { placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', high: '0x6b12ae37b47f5b37', low: '0x8eaddfcd1b32ca52' };

// Real places from Yogyakarta (their short links were expanded once to get these long URLs).
const REDDOORZ_LONG = 'https://www.google.com/maps/place/RedDoorz+@+Savitri+Hotel/@-7.7381968,110.3834826,17z/data=!4m9!3m8!1s0x2e7a5919022e4893:0x40f12d5bc33d3f93!5m2!4m1!1i2!8m2!3d-7.738!4d110.383!16s%2Fg%2F11abc?entry=ttu';
const REDDOORZ_PLACE_ID = 'ChIJk0guAhlZei4Rkz89w1st8UA';

describe('Place ID (steps 3 and 4)', () => {
  it('builds exactly the documented example: 20 bytes 0A 12 09 | low-endian | 11 | little-endian', () => {
    assert.equal(buildPlaceId(BigInt(SYDNEY.high), BigInt(SYDNEY.low)), SYDNEY.placeId);
    const bytes = Buffer.from(SYDNEY.placeId, 'base64url');
    assert.equal(bytes.length, 20);
    assert.equal(bytes.subarray(0, 3).toString('hex'), '0a1209');
    assert.equal(bytes[11], 0x11);
    assert.equal(bytes.subarray(3, 11).toString('hex'), '375b7fb437ae126b', 'the first number, least significant byte first');
  });

  it('always starts with ChIJ, has 27 characters and uses no padding', () => {
    for (const [a, b] of [[1n, 2n], [0xffffffffffffffffn, 0xffffffffffffffffn], [0x2e7a5919022e4893n, 0x40f12d5bc33d3f93n], [0n, 7n]]) {
      const id = buildPlaceId(a, b);
      assert.match(id, /^ChIJ[A-Za-z0-9_-]{23}$/, id);
      assert.equal(id.length, 27);
      assert.ok(!id.includes('='));
      assert.equal(isPlaceId(id), true);
    }
  });

  it('parses back what it built, and refuses anything that is not such an id', () => {
    assert.deepEqual(parsePlaceId(SYDNEY.placeId), { high: BigInt(SYDNEY.high), low: BigInt(SYDNEY.low) });
    for (const bad of ['', 'ChIJ', 'ChIJN1t_tDeuEmsRUsoyG83frY', 'chijN1t_tDeuEmsRUsoyG83frY4', `${SYDNEY.placeId}x`, 'ChIJ!!!!!!!!!!!!!!!!!!!!!!!', null, undefined, 42]) {
      assert.equal(parsePlaceId(bad), null, String(bad));
      assert.equal(isPlaceId(bad), false, String(bad));
    }
  });

  it('reads the ids from "!1s0xAAAA:0xBBBB" and from "ftid=0xAAAA:0xBBBB", decoded first', () => {
    assert.deepEqual(extractLocationIds(REDDOORZ_LONG), { high: 0x2e7a5919022e4893n, low: 0x40f12d5bc33d3f93n });
    assert.deepEqual(extractLocationIds('https://www.google.com/maps/place/?q=x&ftid=0x2e7a5919022e4893:0x40f12d5bc33d3f93&entry=ttu'), { high: 0x2e7a5919022e4893n, low: 0x40f12d5bc33d3f93n });
    // percent-encoded, and nested in a consent page's continue= parameter (encoded twice)
    assert.deepEqual(extractLocationIds('https://www.google.com/maps/place/x/data=!4m2!3m1!1s0x2e7a5919022e4893%3A0x40f12d5bc33d3f93'), { high: 0x2e7a5919022e4893n, low: 0x40f12d5bc33d3f93n });
    const nested = `https://consent.google.com/ml?continue=${encodeURIComponent(encodeURIComponent(REDDOORZ_LONG))}`;
    assert.deepEqual(extractLocationIds(nested), { high: 0x2e7a5919022e4893n, low: 0x40f12d5bc33d3f93n });
  });

  it('turns a real Maps URL into the Place ID that its short link gave', () => {
    const ids = extractLocationIds(REDDOORZ_LONG);
    assert.equal(buildPlaceId(ids.high, ids.low), REDDOORZ_PLACE_ID);
  });

  it('accepts short hex numbers (leading zeros are dropped in some URLs) and refuses what is not a location id', () => {
    assert.deepEqual(extractLocationIds('https://www.google.com/maps/place/x/data=!1s0x1:0xabc'), { high: 1n, low: 0xabcn });
    for (const url of [
      'https://www.google.com/maps/place/x/@1,2,17z',
      'https://www.google.com/maps/place/x/data=!1s0x:0x1',
      'https://www.google.com/maps/place/x/data=!1s0x0:0x0',
      'https://www.google.com/maps/place/x/data=!1s0x2e7a5919022e48931:0x40f12d5bc33d3f93', // 17 digits: more than 64 bits
      'https://www.google.com/maps/place/x/data=!1s0xZZ:0x1',
      'https://www.google.com/maps?cid=12345678901234567890',
    ]) {
      assert.equal(extractLocationIds(url), null, url);
    }
  });

  it('survives broken percent-encoding instead of throwing', () => {
    assert.equal(decodeRepeatedly('%E0%A4%A'), '%E0%A4%A');
    assert.deepEqual(extractLocationIds('https://www.google.com/maps/place/100%25+Halal%2/data=!1s0x1:0x2'), { high: 1n, low: 2n });
  });

  it('builds the review link from the Place ID (step 5)', () => {
    assert.equal(reviewUrlFor(SYDNEY.placeId), `https://search.google.com/local/writereview?placeid=${SYDNEY.placeId}`);
  });

  it('falls back to a Place ID that is already in the address (a Business Profile review link, a place_id: query)', () => {
    for (const url of [
      `https://search.google.com/local/writereview?placeid=${SYDNEY.placeId}`,
      `https://search.google.com/local/writereview?hl=id&placeid=${SYDNEY.placeId}&source=g.page.share`,
      `https://www.google.com/maps/place/?q=place_id:${SYDNEY.placeId}`,
      `https://www.google.com/maps/search/?api=1&query=x&query_place_id=${SYDNEY.placeId}`,
      `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(`https://search.google.com/local/writereview?placeid=${SYDNEY.placeId}`)}`,
    ]) {
      assert.equal(extractPlaceId(url), SYDNEY.placeId, url);
    }
    for (const url of [
      'https://search.google.com/local/writereview',
      'https://search.google.com/local/writereview?placeid=ChIJshort',
      `https://search.google.com/local/writereview?placeid=${SYDNEY.placeId}extra_characters_make_it_a_different_id`,
      `https://search.google.com/local/writereview?placeid=${SYDNEY.placeId.toLowerCase()}`, // Place IDs are case-sensitive
      'https://www.google.com/maps/place/x/@1,2,17z',
    ]) {
      assert.equal(extractPlaceId(url), null, url);
    }
  });
});

describe('which links are accepted (step 1)', () => {
  const accepted = [
    ['https://www.google.com/maps/place/Nama/@-7.7,110.3,17z', 'long'],
    ['https://google.com/maps?q=x', 'long'],
    ['https://www.google.com/maps', 'long'],
    ['https://maps.google.com/?q=x', 'long'],
    ['https://maps.google.co.id/maps?q=x', 'long'],
    ['https://maps.google.com.au/maps?q=x', 'long'],
    ['https://goo.gl/maps/AbCdEf123', 'short'],
    ['https://maps.app.goo.gl/AZQV8dReQ9ZFcqjv6', 'short'],
    ['https://maps.app.goo.gl/AZQV8dReQ9ZFcqjv6?g_st=ic', 'short'],
    ['https://g.page/nama-toko', 'short'],
    ['maps.app.goo.gl/AZQV8dReQ9ZFcqjv6', 'short'], // pasted without the scheme
    ['  https://maps.app.goo.gl/AZQV8dReQ9ZFcqjv6  ', 'short'],
    ['HTTPS://MAPS.APP.GOO.GL/AZQV8dReQ9ZFcqjv6', 'short'],
    ['http://maps.app.goo.gl/AZQV8dReQ9ZFcqjv6', 'short'], // plain http is upgraded, never used
  ];
  for (const [input, kind] of accepted) {
    it(`accepts ${JSON.stringify(input)} as a ${kind} link`, () => {
      const res = parseMapsLink(input);
      assert.equal(res.ok, true, res.error);
      assert.equal(res.kind, kind);
      assert.equal(res.url.protocol, 'https:');
      assert.ok(res.href.startsWith('https://'));
    });
  }

  const refused = [
    ['', /wajib diisi/],
    ['   ', /wajib diisi/],
    ['https://example.com/maps', /dari Google Maps/],
    ['https://www.google.com/search?q=maps', /dari Google Maps/],
    ['https://www.google.com/', /dari Google Maps/],
    ['https://google.com.evil.test/maps/place/x', /dari Google Maps/],
    ['https://evilgoogle.com/maps/place/x', /dari Google Maps/],
    ['https://maps.google.com.evil.test/x', /dari Google Maps/],
    ['https://maps.app.goo.gl.evil.test/abc', /dari Google Maps/],
    ['https://notmaps.app.goo.gl/abc', /dari Google Maps/],
    ['https://goo.gl/abc', /dari Google Maps/], // goo.gl is accepted only under /maps
    ['https://goo.gl/', /dari Google Maps/],
    ['https://maps.app.goo.gl/', /dari Google Maps/],
    ['https://g.page/', /dari Google Maps/],
    ['https://www.google.com/mapsevil/x', /dari Google Maps/],
    ['https://maps.google.com@evil.test/', /username atau password/],
    ['https://user:pass@maps.app.goo.gl/abc', /username atau password/],
    ['https://maps.app.goo.gl:8443/abc', /tidak valid/],
    ['https://127.0.0.1/maps/x', /dari Google Maps/],
    ['https://localhost/maps/x', /dari Google Maps/],
    ['javascript:alert(1)', /https/],
    ['ftp://maps.app.goo.gl/abc', /https/],
    ['data:text/html,<script>alert(1)</script>', /https/],
    ['https://maps.app.goo.gl/a b', /spasi/],
    ['not a link', /spasi/],
    ['https://', /tidak valid/],
    [`https://www.google.com/maps/${'a'.repeat(2100)}`, /terlalu panjang/],
  ];
  for (const [input, message] of refused) {
    it(`refuses ${JSON.stringify(input.length > 60 ? `${input.slice(0, 57)}...` : input)}`, () => {
      const res = parseMapsLink(input);
      assert.equal(res.ok, false);
      assert.match(res.error, message);
    });
  }

  it('drops the fragment and keeps the rest of the link as the "original link"', () => {
    const res = parseMapsLink('http://maps.app.goo.gl/AZQV8dReQ9ZFcqjv6?g_st=ic#tracking');
    assert.equal(res.href, 'https://maps.app.goo.gl/AZQV8dReQ9ZFcqjv6?g_st=ic');
  });

  it('classifyMapsUrl and isGoogleHost agree on what belongs to Google', () => {
    assert.equal(classifyMapsUrl(new URL('https://www.google.com/maps/place/x')), 'long');
    assert.equal(classifyMapsUrl(new URL('https://www.google.com/other')), null);
    for (const host of ['google.com', 'www.google.com', 'consent.google.com', 'google.co.id', 'maps.google.com.au', 'goo.gl', 'maps.app.goo.gl', 'g.page']) assert.equal(isGoogleHost(host), true, host);
    for (const host of ['evil.test', 'google.com.evil.test', 'evilgoogle.com', 'goo.gl.evil.test', 'g.page.evil.test', 'localhost', '127.0.0.1', '169.254.169.254', '', null]) assert.equal(isGoogleHost(host), false, String(host));
  });
});

/** A scripted stand-in for fetch: answers from a table and records every request it was asked to make. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (typeof route === 'function') return route(url, options);
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route;
  };
  impl.calls = calls;
  return impl;
}
const redirect = (location, status = 302) => ({ status, headers: new Headers(location === null ? {} : { location }), body: { cancel: async () => {} } });

describe('expanding short links on the server (step 2)', () => {
  it('reads the Location header of a short link, without following it and without downloading the page', async () => {
    let cancelled = false;
    const response = { status: 302, headers: new Headers({ location: REDDOORZ_LONG }), body: { cancel: async () => { cancelled = true; } } };
    const fetchImpl = fakeFetch({ 'https://maps.app.goo.gl/AZQV8dReQ9ZFcqjv6': response });
    const res = await createMapsResolver({ fetch: fetchImpl }).resolve('https://maps.app.goo.gl/AZQV8dReQ9ZFcqjv6');

    assert.deepEqual(res, {
      ok: true,
      placeId: REDDOORZ_PLACE_ID,
      reviewUrl: `https://search.google.com/local/writereview?placeid=${REDDOORZ_PLACE_ID}`,
      sourceUrl: 'https://maps.app.goo.gl/AZQV8dReQ9ZFcqjv6',
    });
    assert.equal(fetchImpl.calls.length, 1, 'one request: the long URL already carries the ids, so it is not fetched');
    assert.equal(fetchImpl.calls[0].options.method, 'GET');
    assert.equal(fetchImpl.calls[0].options.redirect, 'manual', 'redirects are never followed automatically');
    assert.ok(fetchImpl.calls[0].options.signal, 'every request has a timeout');
    assert.equal(cancelled, true, 'the response body is dropped unread');
  });

  it('uses the Place ID straight from a review link (what g.page/r/.../review leads to), and prefers the location id when both exist', async () => {
    const review = `https://search.google.com/local/writereview?placeid=${SYDNEY.placeId}`;
    const fetchImpl = fakeFetch({ 'https://g.page/r/CabcDEF/review': redirect(review) });
    const res = await createMapsResolver({ fetch: fetchImpl }).resolve('https://g.page/r/CabcDEF/review');
    assert.deepEqual(res, { ok: true, placeId: SYDNEY.placeId, reviewUrl: `https://search.google.com/local/writereview?placeid=${SYDNEY.placeId}`, sourceUrl: 'https://g.page/r/CabcDEF/review' });
    assert.equal(fetchImpl.calls.length, 1);

    // a long link with a place_id: query needs no request at all
    const longWithPlaceId = await createMapsResolver({ fetch: fakeFetch({}) }).resolve(`https://www.google.com/maps/place/?q=place_id:${SYDNEY.placeId}`);
    assert.equal(longWithPlaceId.placeId, SYDNEY.placeId);

    // both present: the documented recipe (the location id) wins
    const both = await createMapsResolver({ fetch: fakeFetch({}) }).resolve(`${REDDOORZ_LONG}&placeid=${SYDNEY.placeId}`);
    assert.equal(both.placeId, REDDOORZ_PLACE_ID);
  });

  it('does not touch the network for a long link', async () => {
    const fetchImpl = fakeFetch({});
    const res = await createMapsResolver({ fetch: fetchImpl }).resolve(REDDOORZ_LONG);
    assert.equal(res.ok, true);
    assert.equal(res.placeId, REDDOORZ_PLACE_ID);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('follows a chain of short links, resolves a relative Location, and reads ids nested in a consent redirect', async () => {
    const consent = `https://consent.google.com/ml?continue=${encodeURIComponent(REDDOORZ_LONG)}`;
    const fetchImpl = fakeFetch({
      'https://goo.gl/maps/AbCdEf123': redirect('https://maps.app.goo.gl/Second'),
      'https://maps.app.goo.gl/Second': redirect('/Third'),
      'https://maps.app.goo.gl/Third': redirect(consent),
    });
    const res = await createMapsResolver({ fetch: fetchImpl }).resolve('https://goo.gl/maps/AbCdEf123');
    assert.equal(res.ok, true, res.error);
    assert.equal(res.placeId, REDDOORZ_PLACE_ID);
    assert.deepEqual(fetchImpl.calls.map((c) => c.url), ['https://goo.gl/maps/AbCdEf123', 'https://maps.app.goo.gl/Second', 'https://maps.app.goo.gl/Third']);
  });

  it('gives up after five redirects', async () => {
    const routes = {};
    for (let i = 0; i < 12; i += 1) routes[`https://maps.app.goo.gl/hop${i}`] = redirect(`https://maps.app.goo.gl/hop${i + 1}`);
    const fetchImpl = fakeFetch(routes);
    const res = await createMapsResolver({ fetch: fetchImpl }).resolve('https://maps.app.goo.gl/hop0');
    assert.equal(res.ok, false);
    assert.equal(fetchImpl.calls.length, 5, 'exactly five requests, then it stops');
  });

  it('never follows a redirect that leaves Google: the request is not even made', async () => {
    for (const target of ['https://evil.test/x', 'https://google.com.evil.test/maps', 'http://169.254.169.254/latest/meta-data/', 'https://127.0.0.1/admin', 'https://localhost:3000/', 'https://user@www.google.com/maps', 'https://www.google.com:8443/maps', 'ftp://www.google.com/maps', 'javascript:alert(1)']) {
      const fetchImpl = fakeFetch({ 'https://maps.app.goo.gl/x': redirect(target) });
      const res = await createMapsResolver({ fetch: fetchImpl }).resolve('https://maps.app.goo.gl/x');
      assert.equal(res.ok, false, target);
      assert.match(res.error, /tidak mengarah ke lokasi/, target);
      assert.deepEqual(fetchImpl.calls.map((c) => c.url), ['https://maps.app.goo.gl/x'], `only the short link was requested for ${target}`);
    }
  });

  it('explains what went wrong for a link that is not a redirect, has no Location, or reaches no location', async () => {
    const cases = [
      [{ status: 200, headers: new Headers(), body: { cancel: async () => {} } }, /tidak mengarah ke lokasi/],
      [{ status: 404, headers: new Headers(), body: { cancel: async () => {} } }, /tidak mengarah ke lokasi/],
      [redirect(null), /tidak mengarah ke lokasi/],
      [redirect('https://www.google.com/maps?q=-7.7,110.3'), /ID lokasi tidak ditemukan/],
    ];
    for (const [response, message] of cases) {
      const res = await createMapsResolver({ fetch: fakeFetch({ 'https://maps.app.goo.gl/x': response }) }).resolve('https://maps.app.goo.gl/x');
      assert.equal(res.ok, false);
      assert.match(res.error, message);
    }
  });

  it('turns network errors and timeouts into a friendly message, and logs why (host only, never the whole link)', async () => {
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args) };
    for (const err of [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), new DOMException('The operation timed out', 'TimeoutError')]) {
      const res = await createMapsResolver({ fetch: fakeFetch({ 'https://maps.app.goo.gl/x?token=secret': err }), logger }).resolve('https://maps.app.goo.gl/x?token=secret');
      assert.equal(res.ok, false);
      assert.match(res.error, /tidak bisa dibuka saat ini/);
    }
    assert.equal(warnings.length, 2);
    for (const [fields] of warnings) {
      assert.equal(fields.host, 'maps.app.goo.gl');
      assert.ok(!JSON.stringify(fields).includes('secret'));
    }
  });

  it('refuses a bad link before any request, with the message for the form', async () => {
    const fetchImpl = fakeFetch({});
    const resolver = createMapsResolver({ fetch: fetchImpl });
    assert.match((await resolver.resolve('https://example.com/maps')).error, /dari Google Maps/);
    assert.match((await resolver.resolve('')).error, /wajib diisi/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('stops at the total time budget even when every single request is within its own timeout', async () => {
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      const routes = {};
      for (let i = 0; i < 6; i += 1) routes[`https://maps.app.goo.gl/s${i}`] = () => { clock += 6000; return redirect(`https://maps.app.goo.gl/s${i + 1}`); };
      const fetchImpl = fakeFetch(routes);
      const res = await createMapsResolver({ fetch: fetchImpl, timeoutMs: 4000 }).resolve('https://maps.app.goo.gl/s0');
      assert.equal(res.ok, false);
      assert.ok(fetchImpl.calls.length <= 2, `stopped after ${fetchImpl.calls.length} requests`);
    } finally {
      Date.now = realNow;
    }
  });
});
