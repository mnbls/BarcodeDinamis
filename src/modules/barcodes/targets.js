// Destination handling. A barcode's "tipe tujuan" is only a convenience for building a safe URL:
// whatever the type, the database stores ONE validated string in barcodes.target_url and the
// redirect endpoint never has to interpret anything.
//
// Allowed final schemes: http(s) for websites/WhatsApp, and mailto:/tel: only when generated
// here from validated input. javascript:, data:, file:, vbscript: etc. can never be produced.
//
// "maps_review" is the odd one out: the person pastes a Google Maps link and the destination becomes the review page
// of that place. Turning the link into a Place ID may need the network (short links), so it cannot happen in this
// synchronous, pure module: validateTarget only checks the pasted link, and the barcode service resolves it
// (modules/maps/maps.resolver.js) before anything is stored.

export const TARGET_TYPES = ['url', 'whatsapp', 'email', 'phone', 'maps_review'];

export const TARGET_TYPE_LABELS = {
  url: 'Website / URL',
  whatsapp: 'WhatsApp',
  email: 'Email',
  phone: 'Telepon',
  maps_review: 'Ulasan Google Maps',
};

/** Labels/help texts for the create/edit form (rendered into the page and used by barcodes.js). */
export const TARGET_TYPE_META = {
  url: {
    label: 'URL tujuan',
    placeholder: 'https://contoh.com/produk-a',
    hint: 'Harus diawali http:// atau https://. Bisa diganti kapan saja tanpa mengubah QR Code.',
    inputmode: 'url',
    extra: null,
  },
  whatsapp: {
    label: 'Nomor WhatsApp',
    placeholder: '081234567890',
    hint: 'Awali dengan 0 (Indonesia) atau kode negara, mis. +6281234567890. Pemindai langsung membuka chat.',
    inputmode: 'tel',
    extra: { label: 'Pesan awal (opsional)', placeholder: 'Halo, saya ingin bertanya tentang produk A', hint: 'Terisi otomatis di kolom pesan WhatsApp pemindai.' },
  },
  email: {
    label: 'Alamat email',
    placeholder: 'halo@perusahaan.co.id',
    hint: 'Pemindai akan membuka aplikasi email dengan alamat ini sebagai penerima.',
    inputmode: 'email',
    extra: { label: 'Subjek (opsional)', placeholder: 'Pertanyaan tentang produk A', hint: 'Terisi otomatis sebagai subjek email.' },
  },
  phone: {
    label: 'Nomor telepon',
    placeholder: '0274123456',
    hint: 'Pemindai akan membuka aplikasi telepon dengan nomor ini. Awali 0 untuk nomor Indonesia.',
    inputmode: 'tel',
    extra: null,
  },
  maps_review: {
    label: 'Link Google Maps',
    placeholder: 'https://maps.app.goo.gl/...',
    hint: 'Tempel link lokasi dari Google Maps (Bagikan, lalu Salin link). Pemindai dibawa ke halaman ulasan Google untuk lokasi itu.',
    inputmode: 'url',
    extra: null,
  },
};

export const MAX_URL_LENGTH = 2048;
export const MAX_EXTRA_LENGTH = { whatsapp: 500, email: 200 };

// Any whitespace, C0/C1 control, NBSP or Unicode line separator inside a URL is rejected.
// (Numeric ranges instead of literal escapes: see lib/text.js.)
const WHITESPACE_OR_CONTROL = new RegExp(`[${[[0x00, 0x20], [0x7f, 0xa0], [0x2028, 0x2029]].map(([x, y]) => `${String.fromCodePoint(x)}-${String.fromCodePoint(y)}`).join('')}]`);

const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const fail = (error) => ({ ok: false, error });

/**
 * Validates a website destination. Only http:// and https:// are accepted.
 * Returns { ok: true, url } with the normalised URL, or { ok: false, error }.
 */
export function validateWebUrl(input, { appOrigin } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return fail('URL tujuan wajib diisi.');
  if (raw.length > MAX_URL_LENGTH) return fail(`URL terlalu panjang (maksimal ${MAX_URL_LENGTH} karakter).`);
  if (WHITESPACE_OR_CONTROL.test(raw)) return fail('URL tidak boleh mengandung spasi atau karakter kontrol.');
  if (!/^https?:\/\//i.test(raw)) return fail('URL harus diawali http:// atau https://. Protokol lain tidak diizinkan.');

  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail('Format URL tidak valid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('Hanya protokol http:// dan https:// yang diizinkan.');
  if (!url.hostname) return fail('URL harus memiliki nama domain.');
  if (url.username || url.password) return fail('URL tidak boleh memuat username atau password.');

  // A barcode pointing at another /b/ URL of this very system can create redirect loops.
  if (appOrigin && url.origin === appOrigin && /^\/b(\/|$)/i.test(url.pathname)) {
    return fail('Tujuan tidak boleh mengarah ke barcode di sistem ini sendiri (dapat menyebabkan redirect berputar).');
  }

  const href = url.href;
  if (href.length > MAX_URL_LENGTH) return fail(`URL terlalu panjang (maksimal ${MAX_URL_LENGTH} karakter).`);
  return { ok: true, url: href };
}

/** Digits-only international number. "0812..." is treated as Indonesian (+62). Returns null if invalid. */
export function normalizePhoneDigits(input) {
  const s = String(input ?? '').trim();
  if (!s || !/^\+?[\d\s().-]+$/.test(s)) return null;
  const hasPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!hasPlus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/**
 * Builds the final destination for a given type.
 * @returns {{ok: true, targetUrl: string} | {ok: false, errors: Record<string, string>}}
 */
export function buildTarget(type, { value, extra } = {}, { appOrigin } = {}) {
  const cleanExtra = String(extra ?? '').trim();

  switch (type) {
    case 'url': {
      const r = validateWebUrl(value, { appOrigin });
      return r.ok ? { ok: true, targetUrl: r.url } : { ok: false, errors: { target_value: r.error } };
    }

    case 'whatsapp': {
      const digits = normalizePhoneDigits(value);
      if (!digits) {
        return { ok: false, errors: { target_value: 'Nomor WhatsApp tidak valid. Contoh: 081234567890 atau +6281234567890.' } };
      }
      if (cleanExtra.length > MAX_EXTRA_LENGTH.whatsapp) {
        return { ok: false, errors: { target_extra: `Pesan maksimal ${MAX_EXTRA_LENGTH.whatsapp} karakter.` } };
      }
      const text = cleanExtra ? `?text=${encodeURIComponent(cleanExtra)}` : '';
      return { ok: true, targetUrl: `https://wa.me/${digits}${text}` };
    }

    case 'email': {
      const addr = String(value ?? '').trim();
      if (!addr || addr.length > 190 || !EMAIL_RE.test(addr)) {
        return { ok: false, errors: { target_value: 'Alamat email tidak valid. Contoh: halo@perusahaan.co.id.' } };
      }
      if (cleanExtra.length > MAX_EXTRA_LENGTH.email) {
        return { ok: false, errors: { target_extra: `Subjek maksimal ${MAX_EXTRA_LENGTH.email} karakter.` } };
      }
      const at = addr.lastIndexOf('@');
      const local = encodeURIComponent(addr.slice(0, at));
      const subject = cleanExtra ? `?subject=${encodeURIComponent(cleanExtra)}` : '';
      return { ok: true, targetUrl: `mailto:${local}@${addr.slice(at + 1).toLowerCase()}${subject}` };
    }

    case 'phone': {
      const digits = normalizePhoneDigits(value);
      if (!digits) {
        return { ok: false, errors: { target_value: 'Nomor telepon tidak valid. Contoh: 0274123456 atau +62274123456.' } };
      }
      return { ok: true, targetUrl: `tel:+${digits}` };
    }

    // Resolved by the barcode service (it may have to ask Google to expand a short link), never built here.
    case 'maps_review':
      return { ok: false, errors: { target_type: 'Tujuan Google Maps diproses terpisah.' } };

    default:
      return { ok: false, errors: { target_type: 'Tipe tujuan tidak dikenal.' } };
  }
}

/**
 * Inverse of buildTarget, used to pre-fill the edit form from the stored URL.
 * (A Maps destination is pre-filled from the link the person pasted, not from the review address: see formValuesFor.)
 */
export function parseTarget(type, targetUrl) {
  const url = String(targetUrl ?? '');
  try {
    if (type === 'whatsapp') {
      const u = new URL(url);
      return { value: u.pathname.replace(/^\//, ''), extra: u.searchParams.get('text') ?? '' };
    }
    if (type === 'email') {
      const [addr, query = ''] = url.slice('mailto:'.length).split('?');
      return { value: decodeURIComponent(addr), extra: new URLSearchParams(query).get('subject') ?? '' };
    }
    if (type === 'phone') return { value: url.replace(/^tel:/i, ''), extra: '' };
  } catch {
    /* fall through: show the raw stored value */
  }
  return { value: url, extra: '' };
}

/** True when the browser should be handed off through a small HTML page instead of an HTTP redirect. */
export function needsHandoffPage(targetUrl) {
  return !/^https?:\/\//i.test(targetUrl);
}
