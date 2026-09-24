import { Router } from 'express';
import { changePassword, updateProfile } from '../auth/auth.service.js';

const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
const save = (req) => new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));

/** Read-only information shown on the "Sistem" card. */
async function systemInfo(ctx) {
  const { db, config } = ctx;
  const [server, tables] = await Promise.all([
    db.one(`SELECT split_part(version(), ' on ', 1) AS version, pg_size_pretty(pg_database_size(current_database())) AS size`),
    db.rows(`SELECT relname AS name, reltuples::bigint AS approx FROM pg_class
             WHERE relname IN ('barcodes', 'barcode_scans', 'barcode_history', 'users') AND relkind = 'r'`),
  ]);
  const approx = Object.fromEntries(tables.map((t) => [t.name, Math.max(0, t.approx)]));
  return {
    server,
    approx,
    items: [
      ['Versi aplikasi', config.version],
      ['Lingkungan', config.env],
      ['APP_URL (isi QR Code)', config.appUrl],
      ['Zona waktu', config.timezone],
      ['Format kode', `${config.codes.mode === 'random' ? 'Acak' : 'Berurutan'} (${config.codes.prefix}-...)`],
      ['Error correction QR', config.qr.errorCorrection],
      ['Cache redirect', config.redirect.cacheTtlMs ? `${config.redirect.cacheTtlMs} ms` : 'Nonaktif'],
      ['Anonimisasi IP', config.privacy.anonymizeIp ? 'Aktif' : 'Nonaktif'],
      ['Node.js', process.version],
    ],
    localhostWarning: config.isProd && /localhost|127\.0\.0\.1/.test(config.appUrl),
  };
}

export function createSettingsRouter(ctx) {
  const router = Router();

  async function render(req, res, extra = {}) {
    res.render('admin/settings', {
      title: 'Pengaturan',
      nav: 'settings',
      profileForm: { name: req.user.name, username: req.user.username, email: req.user.email },
      profileErrors: {},
      passwordErrors: {},
      system: await systemInfo(ctx),
      ...extra,
    });
  }

  router.get('/', (req, res) => render(req, res));

  router.post('/profile', async (req, res) => {
    const result = await updateProfile(ctx, req.user, req.body);
    if (!result.ok) {
      res.status(422);
      return render(req, res, { profileForm: req.body, profileErrors: result.errors, section: 'profile' });
    }
    req.flash('success', 'Profil berhasil diperbarui.');
    return res.redirect('/admin/settings');
  });

  router.post('/password', async (req, res) => {
    const result = await changePassword(ctx, req.user, {
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
      confirmPassword: req.body.confirmPassword,
    });
    if (!result.ok) {
      res.status(422);
      return render(req, res, { passwordErrors: result.errors, section: 'password' });
    }
    // Every other session of this account is invalidated by the changed timestamp; this one gets a fresh id.
    await regenerate(req);
    req.session.userId = req.user.id;
    req.session.pwdAt = result.passwordChangedAt.getTime();
    await save(req);
    req.flash('success', 'Password berhasil diganti. Sesi di perangkat lain telah diakhiri.');
    ctx.logger.info({ userId: req.user.id }, 'password changed');
    return res.redirect('/admin/settings');
  });

  return router;
}
