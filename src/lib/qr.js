import QRCode from 'qrcode';

const COLORS = { dark: '#000000', light: '#ffffff' };

/**
 * QR generation. The payload is ALWAYS the dynamic redirect URL ({APP_URL}/b/{code}), never the
 * destination, so a printed code stays valid when the destination changes.
 */
export function createQrService(config) {
  const options = () => ({
    errorCorrectionLevel: config.qr.errorCorrection,
    margin: config.qr.margin,
    color: COLORS,
  });

  const redirectUrl = (code) => `${config.appUrl}/b/${encodeURIComponent(code)}`;

  return {
    redirectUrl,

    /** Decorative QR for arbitrary text (landing page). Never used for real barcodes. */
    svgOf(text) {
      return QRCode.toString(text, { ...options(), type: 'svg', margin: 1 });
    },

    /** SVG markup (vector, scales without loss: best for print). */
    async svg(code, { size } = {}) {
      return QRCode.toString(redirectUrl(code), { ...options(), type: 'svg', ...(size ? { width: size } : {}) });
    },

    /** PNG buffer. The scale is an integer number of pixels per module so edges stay razor sharp. */
    async png(code, { size = config.qr.pngSize } = {}) {
      const target = Math.min(4096, Math.max(128, Number(size) || config.qr.pngSize));
      const text = redirectUrl(code);
      const modules = QRCode.create(text, { errorCorrectionLevel: config.qr.errorCorrection }).modules.size;
      const scale = Math.max(1, Math.floor(target / (modules + 2 * config.qr.margin)));
      return QRCode.toBuffer(text, { ...options(), type: 'png', scale });
    },
  };
}
