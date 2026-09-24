import bcrypt from 'bcryptjs';
import { isPgError, PG } from '../../db/pool.js';
import { cleanLine } from '../../lib/text.js';
import * as users from './users.repo.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,50}$/;
const MAX_PASSWORD_BYTES = 72; // bcrypt ignores everything after 72 bytes

let dummyHashPromise;
/** A real bcrypt hash of a throw-away password, so unknown usernames cost the same time as wrong passwords. */
function dummyHash(rounds) {
  dummyHashPromise ??= bcrypt.hash('timing-equaliser-password', rounds);
  return dummyHashPromise;
}

export const hashPassword = (config, plain) => bcrypt.hash(plain, config.bcryptRounds);

/**
 * Checks credentials. Returns the user row (without hash) or null.
 * Always performs one bcrypt comparison and never says which part was wrong.
 */
export async function authenticate(ctx, identifier, password) {
  const id = cleanLine(identifier).slice(0, 190);
  const candidate = id ? await users.findForLogin(ctx.db, id) : null;
  const hash = candidate?.password_hash ?? (await dummyHash(ctx.config.bcryptRounds));
  const matches = await bcrypt.compare(String(password ?? '').slice(0, 1024), hash);
  if (!candidate || !matches || !candidate.is_active) return null;

  await users.touchLogin(ctx.db, candidate.id);
  const { password_hash: _omit, ...user } = candidate;
  return user;
}

/** Password policy. Returns an error message or null. */
export function passwordProblem(password, { username, email } = {}) {
  const pw = String(password ?? '');
  if (pw.length < 8) return 'Password minimal 8 karakter.';
  if (Buffer.byteLength(pw, 'utf8') > MAX_PASSWORD_BYTES) return `Password terlalu panjang (maksimal ${MAX_PASSWORD_BYTES} byte).`;
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password harus mengandung huruf dan angka.';
  const lower = pw.toLowerCase();
  if (username && lower.includes(String(username).toLowerCase())) return 'Password tidak boleh mengandung username.';
  if (email && lower === String(email).toLowerCase()) return 'Password tidak boleh sama dengan email.';
  return null;
}

export async function createUser(ctx, { name, username, email, password, role = 'admin' }) {
  const problem = passwordProblem(password, { username, email });
  if (problem) throw new Error(problem);
  if (!USERNAME_RE.test(username)) throw new Error('Username 3-50 karakter: huruf, angka, titik, garis bawah, atau strip.');
  if (!EMAIL_RE.test(email)) throw new Error('Format email tidak valid.');
  if (!['admin', 'viewer'].includes(role)) throw new Error('Role harus admin atau viewer.');
  const passwordHash = await hashPassword(ctx.config, password);
  try {
    return await users.create(ctx.db, { name: cleanLine(name), username, email, passwordHash, role });
  } catch (err) {
    if (isPgError(err, PG.UNIQUE_VIOLATION)) throw new Error('Username atau email sudah terdaftar.');
    throw err;
  }
}

/** Validates and saves name/username/email of the signed-in admin. */
export async function updateProfile(ctx, user, input) {
  const errors = {};
  const name = cleanLine(input.name);
  const username = cleanLine(input.username);
  const email = cleanLine(input.email).toLowerCase();

  if (name.length < 2 || name.length > 120) errors.name = 'Nama 2-120 karakter.';
  if (!USERNAME_RE.test(username)) errors.username = 'Username 3-50 karakter: huruf, angka, titik, garis bawah, atau strip.';
  if (!EMAIL_RE.test(email) || email.length > 190) errors.email = 'Format email tidak valid.';
  if (Object.keys(errors).length) return { ok: false, errors };

  try {
    const updated = await users.updateProfile(ctx.db, user.id, { name, username, email });
    return { ok: true, user: updated };
  } catch (err) {
    if (isPgError(err, PG.UNIQUE_VIOLATION)) {
      const field = String(err.constraint ?? '').includes('email') ? 'email' : 'username';
      return { ok: false, errors: { [field]: `${field === 'email' ? 'Email' : 'Username'} sudah dipakai akun lain.` } };
    }
    throw err;
  }
}

/** Changes the password after verifying the current one. */
export async function changePassword(ctx, user, { currentPassword, newPassword, confirmPassword }) {
  const errors = {};
  const row = await users.findWithHash(ctx.db, user.id);
  const currentOk = row && (await bcrypt.compare(String(currentPassword ?? '').slice(0, 1024), row.password_hash));
  if (!currentOk) errors.currentPassword = 'Password saat ini salah.';

  const problem = passwordProblem(newPassword, { username: user.username, email: user.email });
  if (problem) errors.newPassword = problem;
  else if (newPassword === currentPassword) errors.newPassword = 'Password baru harus berbeda dari password saat ini.';
  if (newPassword !== confirmPassword) errors.confirmPassword = 'Konfirmasi password tidak sama.';

  if (Object.keys(errors).length) return { ok: false, errors };

  const { password_changed_at: changedAt } = await users.updatePassword(ctx.db, user.id, await hashPassword(ctx.config, newPassword));
  return { ok: true, passwordChangedAt: changedAt };
}
