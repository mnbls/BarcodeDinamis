import { randomBytes } from 'node:crypto';

// The secret inside an edit link (/e/{token}). 32 random bytes = 256 bits, base64url-encoded to 43
// characters from [A-Za-z0-9_-], so it can sit in a URL path unescaped and cannot be guessed.
const EDIT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const generateEditToken = () => randomBytes(32).toString('base64url');

/** Shape check used before touching the database: anything else is a plain "invalid link". */
export const isEditToken = (value) => typeof value === 'string' && EDIT_TOKEN.test(value);

export const editLinkUrl = (config, token) => `${config.appUrl}/e/${token}`;
