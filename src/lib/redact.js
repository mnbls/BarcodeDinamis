// An edit link is a bearer secret: whoever holds /e/{token} can change the barcode's destination.
// It must therefore never reach access logs, error logs or any monitoring that copies them.
const EDIT_LINK_PATH = /^\/e\/[^/?#]+/i;

/** URL as it may appear in logs: no query string, no fragment, and the edit-link secret masked. */
export function redactUrl(url) {
  return String(url ?? '')
    .split(/[?#]/)[0]
    .replace(EDIT_LINK_PATH, '/e/[redacted]');
}
