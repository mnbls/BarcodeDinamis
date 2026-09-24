// Sets a new password for an existing account (forgotten password). All of that account's
// open sessions end immediately, because the password change invalidates them.
//
//   npm run admin:reset -- --username admin                 -> prompts for the new password
//   ADMIN_PASSWORD='Baru-Password-77' npm run admin:reset -- --username admin
import bcrypt from 'bcryptjs';
import { passwordProblem } from '../src/modules/auth/auth.service.js';
import * as users from '../src/modules/auth/users.repo.js';
import { bootstrap, parseArgs } from './lib/bootstrap.js';
import { ask, askHidden } from './lib/prompt.js';

const args = parseArgs();
const { config, db } = bootstrap();

try {
  const identifier = typeof args.username === 'string' && args.username ? args.username : await ask('Username atau email akun');
  const user = await users.findForLogin(db, identifier);
  if (!user) throw new Error(`Akun "${identifier}" tidak ditemukan.`);

  let password = process.env.ADMIN_PASSWORD || (typeof args.password === 'string' ? args.password : '');
  if (!password) {
    password = await askHidden(`Password baru untuk "${user.username}" (min. 8 karakter, huruf + angka): `);
    if (password !== (await askHidden('Ulangi password: '))) throw new Error('Konfirmasi password tidak sama.');
  }
  const problem = passwordProblem(password, { username: user.username, email: user.email });
  if (problem) throw new Error(problem);

  await users.updatePassword(db, user.id, await bcrypt.hash(password, config.bcryptRounds));
  await db.query('UPDATE users SET is_active = TRUE WHERE id = $1', [user.id]);
  console.log(`Password "${user.username}" diganti. Semua sesi login akun ini telah berakhir.`);
} catch (err) {
  console.error(`Gagal: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
