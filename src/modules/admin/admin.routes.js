import { Router } from 'express';
import { addDays, todayLocal } from '../../lib/dates.js';
import { buildPagination, PER_PAGE_OPTIONS, parsePage, parsePerPage } from '../../lib/pagination.js';
import { cleanLine } from '../../lib/text.js';
import { noStore } from '../../middleware/security.js';
import { requireAuth } from '../../middleware/auth.js';
import * as analytics from '../analytics/analytics.repo.js';
import { loadRangeReport, resolveRange, RANGE_PRESETS, seriesStats } from '../analytics/analytics.service.js';
import * as barcodes from '../barcodes/barcodes.repo.js';
import { createBarcodesRouter } from '../barcodes/barcodes.routes.js';
import { cleanDateFilter } from '../barcodes/barcodes.validation.js';
import { createSettingsRouter } from '../settings/settings.routes.js';

/** Everything under /admin except the CSV import (which is mounted separately, see app.js). */
export function createAdminRouter(ctx) {
  const { db, config } = ctx;
  const router = Router();

  router.use(noStore);
  router.use(requireAuth);

  // --- Dashboard ---------------------------------------------------------------------------------------------
  router.get('/', async (req, res) => {
    const today = todayLocal(config.timezone);
    const from = addDays(today, -29);

    const [counts, scans, series, top, changes] = await Promise.all([
      barcodes.counts(db),
      analytics.summary(db, config.timezone),
      analytics.dailySeries(db, from, today),
      barcodes.topByScans(db, 5),
      barcodes.recentHistory(db, 5),
    ]);

    res.render('admin/dashboard', {
      title: 'Dashboard',
      nav: 'dashboard',
      counts,
      scans,
      series,
      seriesStats: seriesStats(series),
      range: { from, to: today, days: 30 },
      top,
      changes,
    });
  });

  // --- Scan analytics -----------------------------------------------------------------------------------------
  router.get('/analytics', async (req, res) => {
    const range = resolveRange(req.query, config.timezone, '30');
    const [summary, report, counts] = await Promise.all([
      analytics.summary(db, config.timezone),
      loadRangeReport(db, range),
      barcodes.counts(db),
    ]);
    res.render('admin/analytics', {
      title: 'Scan Analytics',
      nav: 'analytics',
      range,
      rangePresets: RANGE_PRESETS,
      summary,
      report,
      totalScans: counts.total_scans,
    });
  });

  // --- Change history (all barcodes) ------------------------------------------------------------------------
  router.get('/history', async (req, res) => {
    const q = cleanLine(req.query.q).slice(0, 100);
    const from = cleanDateFilter(req.query.from);
    const to = cleanDateFilter(req.query.to);
    const perPage = parsePerPage(req.query.per_page, 25);
    const requested = parsePage(req.query.page);

    let { rows, total } = await barcodes.historyFeed(db, { q, from, to, page: requested, perPage }, config.timezone);
    let pagination = buildPagination({ page: requested, perPage, total });
    if (pagination.page !== requested) {
      ({ rows } = await barcodes.historyFeed(db, { q, from, to, page: pagination.page, perPage }, config.timezone));
      pagination = buildPagination({ page: pagination.page, perPage, total });
    }

    res.render('admin/history', {
      title: 'Riwayat Perubahan',
      nav: 'history',
      rows,
      total,
      pagination,
      filters: { q, from, to },
      perPage,
      perPageOptions: PER_PAGE_OPTIONS,
      baseParams: { q, from, to, per_page: perPage === 25 ? '' : perPage },
    });
  });

  router.use('/barcodes', createBarcodesRouter(ctx));
  router.use('/settings', createSettingsRouter(ctx));

  return router;
}
