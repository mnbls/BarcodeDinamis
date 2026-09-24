import { notFound } from '../lib/http-errors.js';
import { redactUrl } from '../lib/redact.js';

const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: (config) => `File terlalu besar. Maksimal ${Math.round(config.imports.maxUploadBytes / 1024 / 1024)} MB.`,
  LIMIT_UNEXPECTED_FILE: () => 'Field file tidak dikenali.',
  LIMIT_FILE_COUNT: () => 'Unggah satu file saja.',
};

/** Decides what the visitor may see. Internals (SQL, stack traces, paths) are never exposed. */
function describe(err, config) {
  if (err.code === 'EBADCSRFTOKEN') {
    return { status: 403, title: 'Sesi formulir kedaluwarsa', message: 'Token keamanan tidak valid. Muat ulang halaman lalu coba lagi.' };
  }
  if (err.name === 'MulterError') {
    const message = (MULTER_MESSAGES[err.code] ?? (() => 'Unggahan file gagal diproses.'))(config);
    return { status: err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, title: 'Unggahan ditolak', message };
  }
  if (err.type === 'entity.too.large') return { status: 413, title: 'Data terlalu besar', message: 'Data yang dikirim melebihi batas yang diizinkan.' };
  if (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'request.aborted') {
    return { status: 400, title: 'Permintaan tidak valid', message: 'Data yang dikirim tidak dapat dibaca.' };
  }
  if (err.expose && Number.isInteger(err.status)) {
    const titles = { 400: 'Permintaan tidak valid', 401: 'Perlu login', 403: 'Akses ditolak', 404: 'Halaman tidak ditemukan' };
    return { status: err.status, title: titles[err.status] ?? 'Terjadi kendala', message: err.message };
  }
  return {
    status: 500,
    title: 'Terjadi kesalahan',
    message: 'Terjadi kesalahan di server kami. Silakan coba lagi beberapa saat lagi.',
  };
}

export function createErrorHandlers(ctx) {
  const { config, logger } = ctx;

  const notFoundHandler = (req, res, next) => next(notFound());

  // Express recognises error handlers by their 4-argument signature.
  const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    const { status, title, message } = describe(err, config);

    if (status >= 500) logger.error({ err, reqId: req.id, url: redactUrl(req.originalUrl), method: req.method }, 'unhandled error');

    // Session expired while submitting a form: send the person back to the login page.
    if (status === 401 && !req.accepts(['html', 'json'])?.includes('json')) {
      req.flash?.('info', 'Sesi Anda berakhir. Silakan login kembali.');
      return res.redirect('/login');
    }

    const wantsJson = req.path.startsWith('/admin/api/') || req.accepts(['html', 'json']) === 'json';
    if (wantsJson) return res.status(status).json({ error: message });

    return res.status(status).render('errors/error', {
      layoutFile: req.user ? 'layouts/admin.njk' : 'layouts/public.njk',
      title,
      status,
      message,
      requestId: status >= 500 ? req.id : undefined,
      detail: config.env === 'development' && status >= 500 ? err.message : undefined, // never outside development
    });
  };

  return { notFoundHandler, errorHandler };
}
