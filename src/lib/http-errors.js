/** Error with an HTTP status. `expose` decides whether the message may be shown to the visitor. */
export class HttpError extends Error {
  constructor(status, message, { expose = true, code } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = expose;
    this.code = code;
  }
}

export const badRequest = (msg = 'Permintaan tidak valid.') => new HttpError(400, msg);
export const unauthorized = (msg = 'Silakan login terlebih dahulu.') => new HttpError(401, msg);
export const forbidden = (msg = 'Anda tidak memiliki izin untuk melakukan aksi ini.') => new HttpError(403, msg);
export const notFound = (msg = 'Halaman yang Anda cari tidak ditemukan.') => new HttpError(404, msg);
