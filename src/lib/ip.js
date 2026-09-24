import net from 'node:net';

/** Returns a canonical IP string, or null when the input is not a valid address. */
export function normalizeIp(raw) {
  if (!raw) return null;
  let ip = String(raw).trim();
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  const zone = ip.indexOf('%');
  if (zone > -1) ip = ip.slice(0, zone);
  return net.isIP(ip) ? ip : null;
}

function expandIPv6(ip) {
  let addr = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    addr = `${addr.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = addr.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length > 1 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.map((g) => g.padStart(4, '0'));
}

/** Privacy option: drops the host part (IPv4: last octet, IPv6: everything after /48). */
export function anonymizeIp(ip) {
  if (!ip) return null;
  if (net.isIPv4(ip)) {
    const p = ip.split('.');
    p[3] = '0';
    return p.join('.');
  }
  if (net.isIPv6(ip)) return `${expandIPv6(ip).slice(0, 3).join(':')}::`;
  return null;
}
