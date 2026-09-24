// Lightweight User-Agent classifier. The output vocabulary is deliberately small and bounded
// (it becomes a dimension of the daily rollup table), so unknown agents fold into "Other".

export const DEVICES = ['mobile', 'tablet', 'desktop', 'bot', 'unknown'];

const BOT =
  /bot\b|bot\/|crawl|spider|slurp|mediapartners|facebookexternalhit|facebot|embedly|linkpreview|link preview|web preview|uripreview|pinterest|vkshare|whatsapp\/|nuzzel|flipboard|headless|lighthouse|pingdom|uptime|curl\/|wget\/|libwww|python-requests|python-urllib|aiohttp|httpx|go-http-client|java\/|apache-httpclient|axios|node-fetch|undici|postman|insomnia|httpie|scrapy|php\//i;

const TABLET = /ipad|tablet|kindle|silk\/|playbook|nexus (?:7|9|10)|sm-t\d|gt-p\d|xoom/i;
const MOBILE = /iphone|ipod|android.+mobile|mobile|windows phone|iemobile|blackberry|bb10|opera mini|opera mobi|webos|symbian|nokia/i;

// Order matters: derivative browsers advertise "Chrome"/"Safari" too, so they come first.
const BROWSERS = [
  [/EdgA?\/|EdgiOS\/|Edge\//, 'Edge'],
  [/OPR\/|OPT\/|Opera|OPiOS\//, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/UCBrowser\/|UCWEB/, 'UC Browser'],
  [/MiuiBrowser\//, 'MIUI Browser'],
  [/Vivaldi\//, 'Vivaldi'],
  [/DuckDuckGo\//, 'DuckDuckGo'],
  [/Instagram/, 'Instagram'],
  [/FBAN|FBAV|FB_IAB|FBIOS/, 'Facebook'],
  [/musical_ly|BytedanceWebview|TikTok|Bytedance/i, 'TikTok'],
  [/\bLine\//, 'LINE'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/;\s*wv\)/, 'WebView'],
  [/Chrome\/|CriOS\/|Chromium\//, 'Chrome'],
  [/Safari\//, 'Safari'],
  [/MSIE |Trident\//, 'Internet Explorer'],
  [/AppleWebKit\//, 'WebView'],
];

const SYSTEMS = [
  [/Windows Phone/i, 'Windows Phone'],
  [/Windows NT|Win64|WOW64|Windows/i, 'Windows'],
  [/Android/i, 'Android'],
  [/iPhone|iPad|iPod/i, 'iOS'],
  [/Macintosh|Mac OS X/i, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux|X11|Ubuntu|Fedora|Debian/i, 'Linux'],
];

const cache = new Map();
const CACHE_LIMIT = 2000;

function classify(ua) {
  if (!ua || !ua.trim()) return { device: 'unknown', browser: 'Other', os: 'Other' };

  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? 'Other';

  if (BOT.test(ua)) return { device: 'bot', browser: 'Bot', os };

  // Real browsers all announce themselves as "Mozilla/5.0 ...". Anything else is a custom HTTP client.
  if (!/^Mozilla\//i.test(ua) && !/^Opera\//i.test(ua)) return { device: 'unknown', browser: 'Other', os };

  let device = 'desktop';
  if (TABLET.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) device = 'tablet';
  else if (MOBILE.test(ua)) device = 'mobile';

  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? 'Other';
  return { device, browser, os };
}

/** Classifies a User-Agent string into { device, browser, os }. Results are memoised. */
export function parseUserAgent(ua) {
  const key = ua ?? '';
  const hit = cache.get(key);
  if (hit) return hit;
  const result = Object.freeze(classify(key));
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}
