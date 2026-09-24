import { toInputDateTime } from '../../lib/dates.js';
import { editLinkUrl, generateEditToken } from '../../lib/edit-token.js';
import { forbidden, notFound } from '../../lib/http-errors.js';
import { parseTarget } from './targets.js';
import * as repo from './barcodes.repo.js';
import { validateBarcodeInput } from './barcodes.validation.js';

const MAX_SELECTED_IDS = 5000;

const ctxOf = (ctx) => ({ appOrigin: ctx.config.appOrigin, timezone: ctx.config.timezone });

function assertWritable(user) {
  if (!user || user.role !== 'admin') throw forbidden();
}

/** Loads a barcode by its (already normalised) code or throws 404. */
export async function getBarcodeOrThrow(ctx, code) {
  const barcode = await repo.findByCode(ctx.db, code);
  if (!barcode) throw notFound('Barcode tidak ditemukan.');
  return barcode;
}

/** Values for pre-filling the edit form from a stored barcode. */
export function formValuesFor(barcode, timezone) {
  const { value, extra } = parseTarget(barcode.target_type, barcode.target_url);
  return {
    name: barcode.name,
    description: barcode.description ?? '',
    target_type: barcode.target_type,
    target_value: value,
    target_extra: extra,
    status: barcode.status,
    expired_at: toInputDateTime(barcode.expired_at, timezone),
  };
}

/**
 * Creates one barcode. Returns { ok: true, barcode } or { ok: false, errors }.
 * The QR encodes only the dynamic /b/{code} URL, so nothing about the destination is baked into it.
 * The destination may be left blank: the barcode then waits in the "pending" state until somebody fills it
 * in, either an admin or a person holding the barcode's edit link.
 */
export async function createBarcode(ctx, input, user) {
  assertWritable(user);
  const { values, errors } = validateBarcodeInput(input, ctxOf(ctx), { allowEmptyTarget: true });
  if (Object.keys(errors).length) return { ok: false, errors };

  const [inserted] = await ctx.db.tx((tx) => repo.insertRows(tx, ctx.config, [values], { createdBy: user.id }));
  const barcode = await repo.findById(ctx.db, inserted.id);
  ctx.logger.info({ code: barcode.code, userId: user.id, pending: barcode.target_url === null }, 'barcode created');
  return { ok: true, barcode };
}

/**
 * Updates a barcode. The row is locked (FOR UPDATE) so two admins editing at once cannot interleave
 * and produce a wrong history. A changed destination writes a barcode_history row in the same
 * transaction. The printed QR never changes: only the database row does.
 */
export async function updateBarcode(ctx, code, input, user) {
  assertWritable(user);
  const outcome = await ctx.db.tx(async (tx) => {
    const current = await repo.findByCode(tx, code, { forUpdate: true });
    if (!current) throw notFound('Barcode tidak ditemukan.');

    // A destination that is already filled in cannot be blanked again; one that was never filled may stay empty.
    const { values, errors } = validateBarcodeInput(input, ctxOf(ctx), {
      currentExpiredAt: current.expired_at,
      allowEmptyTarget: current.target_url === null,
    });
    if (Object.keys(errors).length) return { ok: false, errors, current };

    // The form has minute precision; an untouched expiry keeps its exact stored value (e.g. 23:59:59).
    const unchanged =
      values.expiredLocal !== null &&
      current.expired_at &&
      toInputDateTime(current.expired_at, ctx.config.timezone).replace('T', ' ') === values.expiredLocal.slice(0, 16);

    const updated = await repo.update(tx, current.id, values, { keepExpiry: Boolean(unchanged), timezone: ctx.config.timezone });
    const urlChanged = updated.target_url !== current.target_url;
    if (urlChanged) {
      await repo.insertHistory(tx, { barcodeId: current.id, oldUrl: current.target_url, newUrl: updated.target_url, changedBy: user.id });
    }
    return { ok: true, barcode: updated, previous: current, urlChanged };
  });

  if (outcome.ok) {
    ctx.cache.invalidate(code);
    ctx.logger.info({ code, userId: user.id, urlChanged: outcome.urlChanged }, 'barcode updated');
  }
  return outcome;
}

export async function setBarcodeStatus(ctx, code, status, user) {
  assertWritable(user);
  if (!['active', 'inactive'].includes(status)) throw notFound();
  const barcode = await getBarcodeOrThrow(ctx, code);
  const changed = await repo.setStatus(ctx.db, code, status);
  ctx.cache.invalidate(code);
  ctx.logger.info({ code, status, userId: user.id }, 'barcode status changed');
  return { barcode, changed: changed > 0 };
}

/**
 * The public edit link of a barcode, or null when it has none. Only admins ever see it: whoever holds the
 * link can change the destination, so a read-only "viewer" account must not be able to read it either.
 */
export async function editLinkFor(ctx, barcode, user) {
  if (user?.role !== 'admin') return null;
  const token = await repo.getEditToken(ctx.db, barcode.id);
  return token ? editLinkUrl(ctx.config, token) : null;
}

/** Creates the edit link, or replaces it: the previous link stops working at once. */
export async function issueEditLink(ctx, code, user) {
  assertWritable(user);
  await getBarcodeOrThrow(ctx, code);
  await repo.setEditToken(ctx.db, code, generateEditToken());
  ctx.logger.warn({ code, userId: user.id }, 'edit link issued');
}

/** Removes the edit link: nobody can edit through it any more (a new one can be issued later). */
export async function revokeEditLink(ctx, code, user) {
  assertWritable(user);
  await getBarcodeOrThrow(ctx, code);
  await repo.setEditToken(ctx.db, code, null);
  ctx.logger.warn({ code, userId: user.id }, 'edit link revoked');
}

export async function deleteBarcode(ctx, code, user) {
  assertWritable(user);
  const barcode = await getBarcodeOrThrow(ctx, code);
  await repo.deleteByCode(ctx.db, code);
  ctx.cache.invalidate(code);
  ctx.logger.warn({ code, name: barcode.name, userId: user.id }, 'barcode deleted');
  return barcode;
}

/** Turns an untrusted list of ids (repeated form field) into a clean array of positive integers. */
export function parseIds(raw) {
  const list = [].concat(raw ?? []);
  const ids = new Set();
  for (const v of list) {
    const text = String(v).trim();
    if (!/^\d{1,15}$/.test(text)) continue; // digits only: "1abc", "-5", "1e3" are rejected, not guessed at
    const n = Number(text);
    if (n > 0) ids.add(n);
  }
  return [...ids];
}

/**
 * Bulk operations over a selection (explicit ids) or over everything that matches the current filter
 * ("select all N results"). Returns { affected }.
 */
export async function bulkAction(ctx, { action, ids, selectAll, filters, confirmText }, user) {
  assertWritable(user);
  if (!['activate', 'deactivate', 'delete'].includes(action)) {
    return { ok: false, error: 'Aksi massal tidak dikenal.' };
  }

  let scope;
  let allowAll = false;
  if (selectAll) {
    scope = { ...filters };
    // "Everything" (no filter at all) must be deliberately confirmed for deletion.
    if (action === 'delete' && !Object.values(scope).some(Boolean)) {
      if (String(confirmText ?? '').trim() !== 'HAPUS') {
        return { ok: false, error: 'Untuk menghapus SEMUA barcode, ketik HAPUS pada kolom konfirmasi.' };
      }
      allowAll = true;
    }
  } else {
    if (!ids.length) return { ok: false, error: 'Pilih minimal satu barcode.' };
    if (ids.length > MAX_SELECTED_IDS) return { ok: false, error: `Maksimal ${MAX_SELECTED_IDS} barcode per aksi. Gunakan "pilih semua hasil" untuk jumlah besar.` };
    scope = { ids };
  }

  const tz = ctx.config.timezone;
  let affected;
  if (action === 'delete') affected = await repo.bulkDelete(ctx.db, scope, tz, { allowAll });
  else affected = await repo.bulkSetStatus(ctx.db, scope, action === 'activate' ? 'active' : 'inactive', tz);

  ctx.cache.clear();
  ctx.logger.warn({ action, affected, selectAll: Boolean(selectAll), userId: user.id }, 'bulk action');
  return { ok: true, affected };
}
