const crypto = require('crypto');

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

function getSecret() {
  const explicitSecret = String(process.env.ADMIN_TOKEN_SECRET || '');
  if (explicitSecret.length >= MIN_SECRET_LENGTH) return explicitSecret;

  const password = String(process.env.SENHA_ADMIN || '');
  const databaseSecret = String(process.env.SUPABASE_KEY || '');
  if (!password || !databaseSecret) return '';
  return crypto
    .createHash('sha256')
    .update(`rstreet-admin-token:${password}:${databaseSecret}`)
    .digest('hex');
}

function getAdminPassword() {
  const password = String(process.env.SENHA_ADMIN || '');
  return password.length ? password : '';
}

function isAdminAuthConfigured() {
  return Boolean(getSecret() && getAdminPassword());
}

function sign(payload) {
  const secret = getSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createAdminToken() {
  const issuedAt = Date.now();
  const exp = issuedAt + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    iat: issuedAt,
    exp,
    nonce: crypto.randomBytes(16).toString('hex'),
  })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, expiresAt: exp };
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  if (!payload || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (
    claims?.v !== 1
    || !Number.isFinite(claims?.iat)
    || !Number.isFinite(claims?.exp)
    || !/^[a-f0-9]{32}$/i.test(String(claims?.nonce || ''))
  ) return false;
  if (claims.iat > Date.now() + 60_000 || claims.exp <= Date.now() || claims.exp - claims.iat > TOKEN_TTL_MS) return false;
  const expected = sign(payload);
  if (!expected) return false;
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifyAdminToken(token)) {
    return res.status(401).json({ erro: 'Acesso administrativo invalido.' });
  }
  next();
}

module.exports = {
  createAdminToken,
  requireAdmin,
  verifyAdminToken,
  getAdminPassword,
  isAdminAuthConfigured,
};
