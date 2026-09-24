const PUBLIC_COLUMNS = 'id, name, username, email, role, is_active, password_changed_at, last_login_at, created_at, updated_at';

export const findById = (db, id) => db.one(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);

/** Includes password_hash: use ONLY for credential checks, never pass the row to a view. */
export const findForLogin = (db, identifier) =>
  db.one(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users
     WHERE lower(username) = lower($1) OR lower(email) = lower($1)
     ORDER BY id LIMIT 1`,
    [identifier],
  );

export const findWithHash = (db, id) => db.one(`SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE id = $1`, [id]);

export const create = (db, { name, username, email, passwordHash, role = 'admin' }) =>
  db.one(
    `INSERT INTO users (name, username, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PUBLIC_COLUMNS}`,
    [name, username, email, passwordHash, role],
  );

export const updateProfile = (db, id, { name, username, email }) =>
  db.one(
    `UPDATE users SET name = $2, username = $3, email = $4, updated_at = now() WHERE id = $1
     RETURNING ${PUBLIC_COLUMNS}`,
    [id, name, username, email],
  );

export const updatePassword = (db, id, passwordHash) =>
  db.one(
    `UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1
     RETURNING password_changed_at`,
    [id, passwordHash],
  );

export const touchLogin = (db, id) => db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);

export const count = async (db) => (await db.one('SELECT count(*)::bigint AS n FROM users')).n;
