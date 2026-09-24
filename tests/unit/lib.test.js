import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatSequentialCode, generateRandomCode, isUnguessableCode, normalizeCode } from '../../src/lib/codes.js';
import { CSV_BOM, canonicalHeader, csvCell, csvLine, detectDelimiter, parseCsv } from '../../src/lib/csv.js';
import {
  addDays, daysInclusive, formatDate, formatDateTime, isValidDateOnly, nowLocalSql, parseLocalDateTime, startOfMonth, startOfWeek,
  toInputDateTime, toLocalSql,
} from '../../src/lib/dates.js';
import { anonymizeIp, normalizeIp } from '../../src/lib/ip.js';
import { buildPagination, toQuery } from '../../src/lib/pagination.js';
import { cleanHeader, cleanLine, cleanMultiline, escapeLike, stripFormulaGuard, truncate } from '../../src/lib/text.js';
import { parseUserAgent } from '../../src/lib/ua.js';
import { UA } from '../helpers/app.js';

describe('codes', () => {
  it('formats sequential codes as BR-000001 and grows past six digits', () => {
    assert.equal(formatSequentialCode('BR', 1), 'BR-000001');
    assert.equal(formatSequentialCode('BR', 10000), 'BR-010000');
    assert.equal(formatSequentialCode('BR', 1234567), 'BR-1234567');
  });

  it('random codes are unambiguous, well-formed and (practically) collision free', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) {
      const c = generateRandomCode('BR');
      assert.match(c, /^BR-[2-9A-HJKMNP-Z]{8}$/, 'no 0/1/I/L/O');
      seen.add(c);
    }
    assert.equal(seen.size, 5000);
  });

  it('a random code always has a letter, and only random codes count as unguessable', () => {
    for (let i = 0; i < 20000; i += 1) {
      const c = generateRandomCode('BR');
      assert.match(c, /^BR-[2-9A-HJKMNP-Z]{8}$/);
      assert.ok(/[A-Z]/.test(c.slice(3)), `${c} has no letter`);
      assert.equal(isUnguessableCode(c), true, c);
    }
    // sequential codes are digits only, however long they grow: they can be counted through
    for (const counted of ['BR-000001', 'BR-000037', 'BR-999999', 'BR-1000000', 'BR-23456789']) assert.equal(isUnguessableCode(counted), false, counted);
    // anything that is not shaped like a code, or is too short to be one of ours, never qualifies
    for (const other of ['', 'BR', 'BR-', 'BR-AB2', 'BR-ABCDEFG', 'br-7k3m9qxt', 'BR-7K3M9QX!', "BR-7K3M9QXT'; --", 'B1-7K3M9QXT', undefined, null, 42]) {
      assert.equal(isUnguessableCode(other), false, String(other));
    }
    assert.equal(isUnguessableCode('BR-7K3M9QXT'), true);
    assert.equal(isUnguessableCode('QR-0000000A'), true, 'other prefixes work the same');
  });

  it('normalizeCode upper-cases and rejects anything that is not a code', () => {
    assert.equal(normalizeCode(' br-000001 '), 'BR-000001');
    assert.equal(normalizeCode('BR-7K3M9QXT'), 'BR-7K3M9QXT');
    for (const bad of ['', 'BR', 'BR-', '000001', "BR-1'; DROP TABLE barcodes;--", 'BR-000001/../x', 'BR-00 1', 'B-1', 'BR-' + 'A'.repeat(30), undefined, null, 42]) {
      assert.equal(normalizeCode(bad), null, `should reject ${String(bad)}`);
    }
  });
});

describe('user agent classification', () => {
  const cases = [
    [UA.android, 'mobile', 'Chrome', 'Android'],
    [UA.iphone, 'mobile', 'Safari', 'iOS'],
    [UA.windowsChrome, 'desktop', 'Chrome', 'Windows'],
    [UA.windowsEdge, 'desktop', 'Edge', 'Windows'],
    [UA.macSafari, 'desktop', 'Safari', 'macOS'],
    [UA.firefox, 'desktop', 'Firefox', 'Windows'],
    [UA.ipad, 'tablet', 'Safari', 'iOS'],
    [UA.samsung, 'mobile', 'Samsung Internet', 'Android'],
    [UA.googlebot, 'bot', 'Bot', 'Other'],
    [UA.curl, 'bot', 'Bot', 'Other'],
    ['WhatsApp/2.24.5.78 A', 'bot', 'Bot', 'Other'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 330.0.0.0', 'mobile', 'Instagram', 'iOS'],
    ['Mozilla/5.0 (Linux; Android 10; Mi 9T; wv) AppleWebKit/537.36 Version/4.0 Chrome/120.0 Mobile Safari/537.36', 'mobile', 'WebView', 'Android'],
    ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'tablet', 'Chrome', 'Android'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0', 'desktop', 'Firefox', 'Linux'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'desktop', 'Chrome', 'ChromeOS'],
  ];
  for (const [ua, device, browser, os] of cases) {
    it(`${device}/${browser}/${os}: ${ua.slice(0, 60)}...`, () => {
      assert.deepEqual({ ...parseUserAgent(ua) }, { device, browser, os });
    });
  }

  it('handles empty, garbage and non-browser agents without throwing', () => {
    assert.deepEqual({ ...parseUserAgent('') }, { device: 'unknown', browser: 'Other', os: 'Other' });
    assert.deepEqual({ ...parseUserAgent(undefined) }, { device: 'unknown', browser: 'Other', os: 'Other' });
    assert.equal(parseUserAgent('SomeCustomClient/1.0').device, 'unknown');
    assert.equal(parseUserAgent('x'.repeat(5000)).device, 'unknown');
  });
});

describe('text sanitising', () => {
  it('cleanLine strips control and bidi characters and collapses whitespace', () => {
    assert.equal(cleanLine('  Halo\u0000​   dunia‮ \n x '), 'Halo dunia x');
    assert.equal(cleanLine(null), '');
    assert.equal(cleanLine('café'), 'café'.normalize('NFC'));
  });

  it('cleanMultiline keeps single line breaks only', () => {
    assert.equal(cleanMultiline('a\r\nb\n\n\n\nc'), 'a\nb\n\nc');
  });

  it('cleanHeader/truncate bound untrusted headers', () => {
    assert.equal(cleanHeader('x'.repeat(900), 512).length, 512);
    assert.equal(cleanHeader('   ', 10), null);
    assert.equal(truncate('abcdef', 3), 'abc');
  });

  it('escapeLike neutralises LIKE wildcards; stripFormulaGuard undoes the CSV guard', () => {
    assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
    assert.equal(stripFormulaGuard("'=SUM(A1)"), '=SUM(A1)');
    assert.equal(stripFormulaGuard("'normal"), "'normal");
  });
});

describe('dates', () => {
  it('formats in the application timezone (dd-mm-yyyy HH:mm)', () => {
    const d = new Date('2026-09-23T03:00:00Z'); // 10:00 in WIB
    assert.equal(formatDateTime(d, 'Asia/Jakarta'), '23-09-2026 10:00');
    assert.equal(formatDateTime(d, 'UTC'), '23-09-2026 03:00');
    assert.equal(formatDate('2026-09-23', 'Asia/Jakarta'), '23-09-2026');
    assert.equal(toInputDateTime(d, 'Asia/Jakarta'), '2026-09-23T10:00');
    assert.equal(toLocalSql(d, 'Asia/Jakarta'), '2026-09-23 10:00:00');
    assert.equal(formatDateTime(null, 'UTC'), '');
  });

  it('a late-evening UTC instant is already "tomorrow" in Jakarta', () => {
    assert.equal(nowLocalSql('Asia/Jakarta', new Date('2026-09-23T20:30:00Z')).slice(0, 10), '2026-09-24');
  });

  it('parseLocalDateTime accepts common formats, date-only means end of day, and rejects impossible dates', () => {
    assert.equal(parseLocalDateTime('2026-12-31T17:30'), '2026-12-31 17:30:00');
    assert.equal(parseLocalDateTime('2026-12-31 17:30:15'), '2026-12-31 17:30:15');
    assert.equal(parseLocalDateTime('2026-12-31'), '2026-12-31 23:59:59');
    assert.equal(parseLocalDateTime('31-12-2026'), '2026-12-31 23:59:59');
    assert.equal(parseLocalDateTime('31/12/2026 08:05'), '2026-12-31 08:05:00');
    for (const bad of ['', 'besok', '2026-02-30', '2026-13-01', '2026-12-31 25:00', '2026-12-31 10:61', '31-31-2026', '1969-12-31']) {
      assert.equal(parseLocalDateTime(bad), null, bad);
    }
    assert.equal(isValidDateOnly('2028-02-29'), true);
    assert.equal(isValidDateOnly('2026-02-29'), false);
  });

  it('calendar arithmetic', () => {
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(daysInclusive('2026-09-01', '2026-09-30'), 30);
    assert.equal(startOfMonth('2026-09-23'), '2026-09-01');
    assert.equal(startOfWeek('2026-09-23'), '2026-09-21'); // Wednesday -> Monday
    assert.equal(startOfWeek('2026-09-21'), '2026-09-21');
    assert.equal(startOfWeek('2026-09-27'), '2026-09-21'); // Sunday belongs to the week that started Monday
  });
});

describe('ip handling', () => {
  it('normalises IPv4-mapped IPv6 and rejects junk', () => {
    assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9');
    assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
    assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
    assert.equal(normalizeIp('unknown'), null);
    assert.equal(normalizeIp("1.2.3.4'; DROP"), null);
    assert.equal(normalizeIp(undefined), null);
  });

  it('anonymises IPv4 (last octet) and IPv6 (keeps /48)', () => {
    assert.equal(anonymizeIp('203.0.113.9'), '203.0.113.0');
    assert.equal(anonymizeIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:0db8:85a3::');
    assert.equal(anonymizeIp('::1'), '0000:0000:0000::');
    assert.equal(anonymizeIp(null), null);
  });
});

describe('pagination helpers', () => {
  it('builds a compact page list', () => {
    const p = buildPagination({ page: 20, perPage: 25, total: 10000 });
    assert.equal(p.totalPages, 400);
    assert.deepEqual(p.pages, [1, '...', 19, 20, 21, '...', 400]);
    assert.equal(p.from, 476);
    assert.equal(p.to, 500);
    assert.equal(p.hasPrev, true);
  });

  it('clamps out-of-range pages and handles empty results', () => {
    assert.equal(buildPagination({ page: 999, perPage: 25, total: 30 }).page, 2);
    const empty = buildPagination({ page: 1, perPage: 25, total: 0 });
    assert.deepEqual({ from: empty.from, to: empty.to, totalPages: empty.totalPages }, { from: 0, to: 0, totalPages: 1 });
  });

  it('toQuery skips empty values and encodes the rest', () => {
    assert.equal(toQuery({ q: 'a b&c', status: '', page: undefined }, { sort: 'name' }), '?q=a+b%26c&sort=name');
    assert.equal(toQuery({}), '');
  });
});

describe('csv', () => {
  it('detects comma, semicolon and tab delimiters (Excel with Indonesian settings uses ;)', () => {
    assert.equal(detectDelimiter('name,description,target_url\nA,B,C'), ',');
    assert.equal(detectDelimiter('name;description;target_url\nA;B;C'), ';');
    assert.equal(detectDelimiter('name\tdescription\ttarget_url'), '\t');
    assert.equal(detectDelimiter('"a,b";c;d'), ';', 'commas inside quotes do not count');
    assert.equal(detectDelimiter('single'), ',');
  });

  it('maps English and Indonesian header aliases to canonical names', () => {
    assert.equal(canonicalHeader('Nama'), 'name');
    assert.equal(canonicalHeader(' URL Tujuan '), 'target_url');
    assert.equal(canonicalHeader('Target-URL'), 'target_url');
    assert.equal(canonicalHeader('Keterangan'), 'description');
    assert.equal(canonicalHeader('Kedaluwarsa'), 'expired_at');
    assert.equal(canonicalHeader(`${CSV_BOM}name`), 'name');
    assert.equal(canonicalHeader('kolom_lain'), 'kolom_lain');
  });

  it('parses quoted cells, embedded newlines, BOM and reports spreadsheet row numbers', () => {
    const csv = `${CSV_BOM}name,description,target_url\r\n"Produk, A","Baris 1\nBaris 2",https://example.com/a\r\n\r\nProduk B,,https://example.com/b\r\n`;
    const { headers, rows } = parseCsv(Buffer.from(csv));
    assert.deepEqual(headers, ['name', 'description', 'target_url']);
    assert.equal(rows.length, 2, 'blank lines are skipped');
    assert.equal(rows[0].data.name, 'Produk, A');
    assert.equal(rows[0].data.description, 'Baris 1\nBaris 2');
    assert.equal(rows[0].row, 2);
    assert.equal(rows[1].row, 3);
  });

  it('parses semicolon files and tolerates ragged rows', () => {
    const { rows } = parseCsv('nama;url\nA;https://a.test\nB');
    assert.equal(rows[0].data.target_url, 'https://a.test');
    assert.equal(rows[1].data.target_url, '');
  });

  it('rejects empty files, binary junk and files over the row limit', () => {
    assert.throws(() => parseCsv(''), /kosong/);
    assert.throws(() => parseCsv(Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04])), /biner/);
    const big = `name,target_url\n${Array.from({ length: 6 }, (_, i) => `n${i},https://x.test/${i}`).join('\n')}`;
    assert.throws(() => parseCsv(big, { maxRows: 5 }), /batas/);
  });

  it('escapes cells per RFC 4180 and defuses spreadsheet formulas', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
    assert.equal(csvCell('a;b', ';'), '"a;b"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(42), '42');
    for (const evil of ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1']) {
      assert.ok(csvCell(evil).replace(/^"/, '').startsWith("'"), `${evil} must be prefixed with an apostrophe`);
    }
    assert.equal(csvLine(['a', 'b,c', 1]), 'a,"b,c",1\r\n');
  });
});
