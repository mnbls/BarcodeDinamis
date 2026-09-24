import { Router } from 'express';
import multer from 'multer';
import { buildPagination, parsePage } from '../../lib/pagination.js';
import { notFound } from '../../lib/http-errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { verifyCsrf } from '../../middleware/csrf.js';
import { noStore } from '../../middleware/security.js';
import * as service from './imports.service.js';

const ERRORS_PER_PAGE = 50;

/**
 * CSV import. Mounted BEFORE the global CSRF check because a multipart body only becomes readable
 * after multer ran; therefore every state-changing route here calls verifyCsrf() itself.
 * (tests/security.test.js asserts that an upload without a token is rejected.)
 */
export function createImportRouter(ctx) {
  const { db, config } = ctx;
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(), // nothing is written to disk
    limits: { fileSize: config.imports.maxUploadBytes, files: 1, fields: 10, parts: 20 },
  });

  // The whole import area (upload form, reports, error files) is for administrators only.
  // When a guard rejects a multipart upload the body is discarded first: answering while the client
  // is still sending makes some clients see a reset connection instead of the 403 / login redirect.
  const guard = (middleware) => (req, res, next) =>
    middleware(req, res, (err) => {
      if (err) req.resume();
      next(err);
    });
  router.use(noStore, guard(requireAuth), guard(requireRole('admin')));

  router.get('/', async (req, res) => {
    res.render('admin/import/index', {
      title: 'Import Barcode',
      nav: 'import',
      recent: await service.recentBatches(db),
      maxRows: config.imports.maxRows,
      maxMb: Math.round(config.imports.maxUploadBytes / 1024 / 1024),
    });
  });

  router.get('/template.csv', (req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="template-import-barcode.csv"' });
    res.send(service.TEMPLATE_CSV);
  });

  router.post(
    '/',
    requireRole('admin'),
    upload.single('file'),
    (req, res, next) => verifyCsrf(req, next),
    async (req, res) => {
      if (!req.file || req.file.size === 0) {
        req.flash('error', 'Pilih file CSV terlebih dahulu.');
        return res.redirect('/admin/import');
      }
      if (!/\.(csv|txt)$/i.test(req.file.originalname)) {
        req.flash('error', 'Format file harus .csv.');
        return res.redirect('/admin/import');
      }

      const result = await service.runImport(ctx, { buffer: req.file.buffer, filename: req.file.originalname }, req.user);
      if (!result.ok) {
        req.flash('error', result.error);
        return res.redirect('/admin/import');
      }
      const { batch } = result;
      req.flash(
        batch.failed_count ? 'info' : 'success',
        `Import selesai: ${batch.success_count.toLocaleString('id-ID')} berhasil, ${batch.failed_count.toLocaleString('id-ID')} gagal.`,
      );
      return res.redirect(`/admin/import/${batch.id}`);
    },
  );

  router.param('id', (req, res, next, value) => {
    const id = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(id) || id < 1) return next(notFound());
    req.batchId = id;
    return next();
  });

  router.get('/:id', async (req, res) => {
    const batch = await service.getBatch(db, req.batchId);
    if (!batch) throw notFound('Data import tidak ditemukan.');
    const page = parsePage(req.query.page);
    const pagination = buildPagination({ page, perPage: ERRORS_PER_PAGE, total: batch.failed_count });
    const errors = batch.failed_count ? await service.errorPage(db, batch.id, pagination.page, ERRORS_PER_PAGE) : [];
    res.render('admin/import/result', { title: `Hasil Import #${batch.id}`, nav: 'import', batch, errors, pagination });
  });

  router.get('/:id/errors.csv', async (req, res) => {
    const batch = await service.getBatch(db, req.batchId);
    if (!batch) throw notFound('Data import tidak ditemukan.');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="import-${batch.id}-baris-gagal.csv"` });
    res.send(await service.errorsCsv(db, batch.id));
  });

  return router;
}
