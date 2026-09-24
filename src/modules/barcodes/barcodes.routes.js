import { Router } from 'express';
import { normalizeCode } from '../../lib/codes.js';
import { cleanLine } from '../../lib/text.js';
import { buildPagination, PER_PAGE_OPTIONS, parsePage, parsePerPage } from '../../lib/pagination.js';
import { notFound } from '../../lib/http-errors.js';
import { requireRole, safeReturn } from '../../middleware/auth.js';
import { loadRangeReport, resolveRange, RANGE_PRESETS } from '../analytics/analytics.service.js';
import * as analytics from '../analytics/analytics.repo.js';
import { delimiterFor, exportFilename, streamBarcodesCsv } from '../imports/export.service.js';
import * as repo from './barcodes.repo.js';
import * as service from './barcodes.service.js';
import { cleanDateFilter } from './barcodes.validation.js';
import { TARGET_TYPE_LABELS } from './targets.js';

const STATUS_FILTERS = ['active', 'inactive', 'expired', 'pending'];

/** Reads and sanitises the list/export filters from a query string or a form body. */
export function parseFilters(source) {
  const status = STATUS_FILTERS.includes(source.status) ? source.status : '';
  const batch = /^\d{1,15}$/.test(String(source.batch ?? '')) ? Number(source.batch) : 0;
  return {
    q: cleanLine(source.q).slice(0, 100),
    status,
    from: cleanDateFilter(source.from),
    to: cleanDateFilter(source.to),
    batch: batch > 0 ? batch : '',
  };
}

export function createBarcodesRouter(ctx) {
  const { db, config, qr } = ctx;
  const router = Router();
  const writer = requireRole('admin');

  // --- :code param: normalised once, unknown shapes are a plain 404 ---------------------------------
  router.param('code', (req, res, next, value) => {
    const code = normalizeCode(value);
    if (!code) return next(notFound('Barcode tidak ditemukan.'));
    req.code = code;
    return next();
  });

  const formLocals = (extra = {}) => ({
    nav: extra.editing ? 'barcodes' : 'create',
    typeLabels: TARGET_TYPE_LABELS,
    ...extra,
  });

  // --- List ---------------------------------------------------------------------------------------------
  router.get('/', async (req, res) => {
    const filters = parseFilters(req.query);
    const sort = Object.hasOwn(repo.SORTS, req.query.sort) ? req.query.sort : 'created_at';
    const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
    const perPage = parsePerPage(req.query.per_page);
    const requestedPage = parsePage(req.query.page);

    let { rows, total } = await repo.list(db, { filters, sort, dir, page: requestedPage, perPage }, config.timezone);
    let pagination = buildPagination({ page: requestedPage, perPage, total });
    if (pagination.page !== requestedPage) {
      // The requested page is beyond the last one (e.g. after deleting rows): show the last page instead.
      ({ rows } = await repo.list(db, { filters, sort, dir, page: pagination.page, perPage }, config.timezone));
      pagination = buildPagination({ page: pagination.page, perPage, total });
    }

    const baseParams = { ...filters, sort, dir, per_page: perPage === 25 ? '' : perPage };
    res.render('admin/barcodes/list', {
      title: 'Semua Barcode',
      nav: 'barcodes',
      rows,
      total,
      pagination,
      filters,
      sort,
      dir,
      perPage,
      perPageOptions: PER_PAGE_OPTIONS,
      baseParams,
      returnTo: req.originalUrl,
      hasFilters: Boolean(filters.q || filters.status || filters.from || filters.to || filters.batch),
    });
  });

  // --- CSV export (read-only: viewers may export too) --------------------------------------------------
  router.get('/export.csv', async (req, res) => {
    await streamBarcodesCsv(ctx, res, {
      filters: parseFilters(req.query),
      delimiter: delimiterFor(req.query.sep),
      filename: exportFilename(config.timezone),
    });
  });

  // --- Create ---------------------------------------------------------------------------------------------
  router.get('/new', writer, (req, res) => {
    res.render('admin/barcodes/form', formLocals({
      title: 'Buat Barcode',
      form: { name: '', description: '', target_type: 'url', target_value: '', target_extra: '', status: 'active', expired_at: '' },
      errors: {},
      action: '/admin/barcodes',
      editing: false,
    }));
  });

  router.post('/', writer, async (req, res) => {
    const result = await service.createBarcode(ctx, req.body, req.user);
    if (!result.ok) {
      return res.status(422).render('admin/barcodes/form', formLocals({
        title: 'Buat Barcode',
        form: req.body,
        errors: result.errors,
        action: '/admin/barcodes',
        editing: false,
      }));
    }
    const pending = result.barcode.target_url === null;
    req.flash(
      'success',
      pending
        ? 'Barcode dibuat, tujuannya belum diisi. Bagikan link edit di bawah agar orang lain bisa mengisinya tanpa login.'
        : 'Barcode berhasil dibuat. QR Code siap diunduh atau dicetak.',
    );
    return res.redirect(`/admin/barcodes/${result.barcode.code}${pending ? '#link-edit' : ''}`);
  });

  // --- Bulk actions (selection or "all results of this filter") -----------------------------------------
  router.post('/bulk', async (req, res) => {
    const action = String(req.body.action ?? '');
    const selectAll = req.body.select_all_matching === '1';
    const filters = parseFilters(req.body);
    const ids = service.parseIds(req.body.ids);
    const returnTo = safeReturn(req.body.return_to);

    if (action === 'export') {
      if (!selectAll && ids.length === 0) {
        req.flash('error', 'Pilih minimal satu barcode untuk diekspor.');
        return res.redirect(returnTo);
      }
      return streamBarcodesCsv(ctx, res, {
        filters: selectAll ? filters : { ids },
        delimiter: delimiterFor(req.body.sep),
        filename: exportFilename(config.timezone),
      });
    }

    const result = await service.bulkAction(ctx, { action, ids, selectAll, filters, confirmText: req.body.confirm_text }, req.user);
    if (!result.ok) {
      req.flash('error', result.error);
      return res.redirect(returnTo);
    }
    const verbs = { activate: 'diaktifkan', deactivate: 'dinonaktifkan', delete: 'dihapus' };
    req.flash('success', `${result.affected.toLocaleString('id-ID')} barcode berhasil ${verbs[action]}.`);
    return res.redirect(returnTo);
  });

  // --- Detail -----------------------------------------------------------------------------------------------
  router.get('/:code', async (req, res) => {
    const barcode = await service.getBarcodeOrThrow(ctx, req.code);
    const range = resolveRange(req.query, config.timezone, '30');

    const [summary, report, recent, history, editLink] = await Promise.all([
      analytics.summary(db, config.timezone, barcode.id),
      loadRangeReport(db, range, { barcodeId: barcode.id }),
      analytics.recentScans(db, barcode.id, 10),
      repo.historyForBarcode(db, barcode.id, 20),
      service.editLinkFor(ctx, barcode, req.user), // null for viewers: the link is a write capability
    ]);

    res.render('admin/barcodes/show', {
      title: barcode.name,
      nav: 'barcodes',
      barcode,
      editLink,
      redirectUrl: qr.redirectUrl(barcode.code),
      summary,
      report,
      range,
      rangePresets: RANGE_PRESETS,
      recent,
      history,
      typeLabels: TARGET_TYPE_LABELS,
    });
  });

  // --- Edit ---------------------------------------------------------------------------------------------------
  router.get('/:code/edit', writer, async (req, res) => {
    const barcode = await service.getBarcodeOrThrow(ctx, req.code);
    res.render('admin/barcodes/form', formLocals({
      title: `Edit ${barcode.code}`,
      barcode,
      form: service.formValuesFor(barcode, config.timezone),
      errors: {},
      action: `/admin/barcodes/${barcode.code}`,
      editing: true,
      redirectUrl: qr.redirectUrl(barcode.code),
    }));
  });

  router.post('/:code', writer, async (req, res) => {
    const result = await service.updateBarcode(ctx, req.code, req.body, req.user);
    if (!result.ok) {
      const barcode = result.current;
      return res.status(422).render('admin/barcodes/form', formLocals({
        title: `Edit ${barcode.code}`,
        barcode,
        form: req.body,
        errors: result.errors,
        action: `/admin/barcodes/${barcode.code}`,
        editing: true,
        redirectUrl: qr.redirectUrl(barcode.code),
      }));
    }
    req.flash(
      'success',
      result.urlChanged
        ? 'Barcode berhasil diperbarui. Tujuan baru langsung aktif dan QR Code yang sudah dicetak tetap berlaku.'
        : 'Barcode berhasil diperbarui.',
    );
    return res.redirect(`/admin/barcodes/${req.code}`);
  });

  // --- Public edit link (create / replace / revoke) ---------------------------------------------------------------
  router.post('/:code/edit-link', writer, async (req, res) => {
    await service.issueEditLink(ctx, req.code, req.user);
    req.flash('success', 'Link edit baru dibuat. Link yang lama tidak berlaku lagi.');
    res.redirect(`/admin/barcodes/${req.code}#link-edit`);
  });

  router.post('/:code/edit-link/revoke', writer, async (req, res) => {
    await service.revokeEditLink(ctx, req.code, req.user);
    req.flash('success', 'Link edit dicabut. Tidak ada lagi yang bisa mengubah tujuan lewat link itu.');
    res.redirect(`/admin/barcodes/${req.code}#link-edit`);
  });

  // --- Status / delete -------------------------------------------------------------------------------------------
  router.post('/:code/status', writer, async (req, res) => {
    const status = req.body.status === 'inactive' ? 'inactive' : 'active';
    await service.setBarcodeStatus(ctx, req.code, status, req.user);
    req.flash('success', `Barcode ${req.code} ${status === 'active' ? 'diaktifkan' : 'dinonaktifkan'}.`);
    res.redirect(safeReturn(req.body.return_to, `/admin/barcodes/${req.code}`));
  });

  router.post('/:code/delete', writer, async (req, res) => {
    await service.deleteBarcode(ctx, req.code, req.user);
    req.flash('success', `Barcode ${req.code} berhasil dihapus.`);
    res.redirect(safeReturn(req.body.return_to, '/admin/barcodes'));
  });

  // --- QR Code: PNG / SVG / print -------------------------------------------------------------------------------------
  const sendQr = (contentType, extension) => async (req, res) => {
    await service.getBarcodeOrThrow(ctx, req.code); // 404 for unknown codes
    const body = extension === 'png' ? await qr.png(req.code, { size: req.query.size }) : await qr.svg(req.code, { size: 1024 });
    res.set('Content-Type', contentType);
    if (req.query.download === '1') res.set('Content-Disposition', `attachment; filename="${req.code}.${extension}"`);
    res.send(body);
  };
  router.get('/:code/qr.png', sendQr('image/png', 'png'));
  router.get('/:code/qr.svg', sendQr('image/svg+xml', 'svg'));

  router.get('/:code/print', async (req, res) => {
    const barcode = await service.getBarcodeOrThrow(ctx, req.code);
    res.render('admin/barcodes/print', {
      title: `Cetak ${barcode.code}`,
      barcode,
      redirectUrl: qr.redirectUrl(barcode.code),
      auto: req.query.auto === '1',
    });
  });

  return router;
}
