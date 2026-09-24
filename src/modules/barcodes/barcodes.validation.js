import { isValidDateOnly, nowLocalSql, parseLocalDateTime, toInputDateTime } from '../../lib/dates.js';
import { cleanLine, cleanMultiline } from '../../lib/text.js';
import { buildTarget, TARGET_TYPES } from './targets.js';

export const LIMITS = { name: 150, description: 1000 };
export const STATUSES = ['active', 'inactive'];

/**
 * Validates the destination part of a form: type + value (+ optional extra such as a WhatsApp message).
 * Used by the admin form, the CSV import and the public edit link, so all three enforce the same rules.
 *
 * @param {object}  input                    raw values: target_type, target_value (or target_url), target_extra
 * @param {object}  ctx                      { appOrigin }
 * @param {object}  [opts]
 * @param {string[]} [opts.allowedTypes]     restrict target types (import allows 'url' only)
 * @param {boolean} [opts.allowEmpty]        a completely blank destination is accepted and means "fill in
 *        later": targetUrl is null. A half-filled one (an extra text but no value) is still an error.
 * @returns {{ targetType: string, targetUrl: string|null, errors: Record<string,string> }}
 */
export function validateTarget(input, ctx, { allowedTypes = TARGET_TYPES, allowEmpty = false } = {}) {
  const errors = {};
  const targetType = cleanLine(input.target_type || 'url').toLowerCase();
  let targetUrl = null;

  if (!allowedTypes.includes(targetType)) {
    errors.target_type = 'Tipe tujuan tidak dikenal.';
  } else {
    const value = input.target_value ?? input.target_url;
    const blank = String(value ?? '').trim() === '' && String(input.target_extra ?? '').trim() === '';
    if (!(allowEmpty && blank)) {
      const built = buildTarget(targetType, { value, extra: input.target_extra }, { appOrigin: ctx.appOrigin });
      if (built.ok) targetUrl = built.targetUrl;
      else Object.assign(errors, built.errors);
    }
  }
  return { targetType, targetUrl, errors };
}

/**
 * Validates the create/edit form (or an import row).
 *
 * @param {object} input       raw body values
 * @param {object} ctx         { appOrigin, timezone }
 * @param {object} [opts]
 * @param {boolean} [opts.allowedTypes]  restrict target types (import allows 'url' only)
 * @param {boolean} [opts.allowEmptyTarget]  the destination may stay blank ("fill in later through the edit link")
 * @param {string|Date|null} [opts.currentExpiredAt]  when editing: the stored value; an unchanged
 *        expiry is accepted even if it lies in the past.
 * @returns {{ values: object, errors: Record<string,string> }}
 *   values.targetUrl is null for a barcode whose destination has not been filled in yet.
 *   values.expiredLocal is a local wall-clock string ("YYYY-MM-DD HH:mm:ss") or null. PostgreSQL turns it
 *   into an instant with AT TIME ZONE, so no timezone arithmetic happens in JavaScript.
 */
export function validateBarcodeInput(input, ctx, { allowedTypes = TARGET_TYPES, allowEmptyTarget = false, currentExpiredAt = null } = {}) {
  const errors = {};

  const name = cleanLine(input.name);
  if (!name) errors.name = 'Nama barcode wajib diisi.';
  else if (Array.from(name).length > LIMITS.name) errors.name = `Nama maksimal ${LIMITS.name} karakter.`;

  const description = cleanMultiline(input.description);
  if (Array.from(description).length > LIMITS.description) errors.description = `Keterangan maksimal ${LIMITS.description} karakter.`;

  const { targetType, targetUrl, errors: targetErrors } = validateTarget(input, ctx, { allowedTypes, allowEmpty: allowEmptyTarget });
  Object.assign(errors, targetErrors);

  const statusRaw = cleanLine(input.status || 'active').toLowerCase();
  const status = STATUSES.includes(statusRaw) ? statusRaw : null;
  if (!status) errors.status = 'Status harus Aktif atau Nonaktif.';

  let expiredLocal = null;
  const expiredRaw = cleanLine(input.expired_at);
  if (expiredRaw) {
    expiredLocal = parseLocalDateTime(expiredRaw);
    if (!expiredLocal) {
      errors.expired_at = 'Tanggal kedaluwarsa tidak valid.';
    } else {
      const unchanged = currentExpiredAt && toInputDateTime(currentExpiredAt, ctx.timezone).replace('T', ' ') === expiredLocal.slice(0, 16);
      if (!unchanged && expiredLocal <= nowLocalSql(ctx.timezone)) {
        errors.expired_at = 'Tanggal kedaluwarsa harus di masa depan.';
      }
    }
  }

  return {
    values: { name, description: description || null, targetType, targetUrl, status, expiredLocal },
    errors,
  };
}

/** Accepts the status vocabulary found in CSV files (English/Indonesian). Returns 'active' | 'inactive' | null. */
export function parseStatusWord(word) {
  const w = String(word ?? '').trim().toLowerCase();
  if (w === '') return 'active';
  if (['active', 'aktif', '1', 'true', 'yes', 'ya', 'y'].includes(w)) return 'active';
  if (['inactive', 'nonaktif', 'non-aktif', 'non aktif', 'tidak aktif', '0', 'false', 'no', 'tidak', 'n'].includes(w)) return 'inactive';
  return null;
}

/** Validates a YYYY-MM-DD filter value; returns the string or ''. */
export function cleanDateFilter(value) {
  const v = String(value ?? '').trim();
  return isValidDateOnly(v) ? v : '';
}
