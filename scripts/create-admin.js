// Creates an admin (or viewer) account.
//
//   npm run admin:create                                   -> interactive prompts
//   npm run admin:create -- --name "Rina" --username rina --email rina@contoh.co.id --role admin
//   ADMIN_PASSWORD=... npm run admin:create -- --username rina --email rina@contoh.co.id --name Rina
//
// The password is never printed and never stored in plain text (bcrypt hash only).
import { createUser } from '../src/modules/auth/auth.service.js';
import { bootstrap, parseArgs } from './lib/bootstrap.js';
import { ask, askHidden } from './lib/prompt.js';

const args = parseArgs();
const { ctx } = bootstrap();

/** A value given as a flag wins; otherwise ask (with an optional default). */
const flagOrAsk = async (label, flag, fallback = '') => (typeof flag === 'string' && flag ? flag : ask(label, fallback));

try {
  const name = await flagOrAsk('Nama lengkap', args.name, 'Administrator');
  const username = await flagOrAsk('Username', args.username, 'admin');
  const email = await flagOrAsk('Email', args.email);
  const role = await flagOrAsk('Role (admin/viewer)', args.role, 'admin');

  let password = process.env.ADMIN_PASSWORD || (typeof args.password === 'string' ? args.password : '');
  if (!password) {
    password = await askHidden('Password (min. 8 karakter, huruf + angka): ');
    const again = await askHidden('Ulangi password: ');
    if (password !== again) throw new Error('Konfirmasi password tidak sama.');
  }

  const user = await createUser(ctx, { name, username, email, password, role });
  console.log(`Akun ${user.role} "${user.username}" berhasil dibuat (id ${user.id}). Silakan login di ${ctx.config.appUrl}/login`);
} catch (err) {
  console.error(`Gagal membuat akun: ${err.message}`);
  process.exitCode = 1;
} finally {
  await ctx.db.end();
}
