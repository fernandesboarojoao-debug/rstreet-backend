const crypto = require('crypto');

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function getSecret() {
  return process.env.ADMIN_TOKEN_SECRET || process.env.SENHA_ADMIN;
}

function sign(payload) {
  const secret = getSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createAdminToken() {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = String(exp);
  return `${payload}.${sign(payload)}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const exp = Number(payload);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = sign(payload);
  if (!expected || expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifyAdminToken(token)) {
    return res.status(401).json({ erro: 'Acesso administrativo invalido.' });
  }
  next();
}

module.exports = { createAdminToken, requireAdmin, verifyAdminToken };
