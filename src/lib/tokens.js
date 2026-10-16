import crypto from 'node:crypto';

const BASE64URL_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;

export function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function isValidTokenFormat(token) {
  if (typeof token !== 'string') return false;
  return BASE64URL_TOKEN_REGEX.test(token);
}
