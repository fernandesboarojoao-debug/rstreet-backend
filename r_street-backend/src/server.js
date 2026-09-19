require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');

const pagamentoRoutes    = require('./routes/pagamento');
const pedidoRoutes       = require('./routes/pedidos');
const webhookRoutes      = require('./routes/webhook');
const authRoutes         = require('./routes/auth');
const produtosRoutes     = require('./routes/produtos');
const pedidosAdminRoutes = require('./routes/pedidosAdmin');
const engajamentoRoutes  = require('./routes/engajamento');
const { requireAdmin, isAdminAuthConfigured } = require('./middleware/adminAuth');

const app  = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  const incomingRequestId = String(req.headers['x-request-id'] || '');
  const requestId = /^[a-z0-9._:-]{1,100}$/i.test(incomingRequestId) ? incomingRequestId : crypto.randomUUID();
  req.requestId = requestId;
  res.set({
    'X-Request-Id': requestId,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  if (isProduction) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (/^\/api\/(auth|admin|produtos)/.test(req.path)) res.set('Cache-Control', 'no-store');
  next();
});

const allowedOrigins = new Set([
  process.env.FRONTEND_URL,
  'https://rstreet.com.br',
  'https://www.rstreet.com.br',
  ...(!isProduction ? ['http://localhost:5500', 'http://127.0.0.1:5500'] : []),
].filter(Boolean));

function simpleRateLimit({ windowMs, max, keyPrefix }) {
  const hits = new Map();
  let requestCount = 0;
  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    requestCount += 1;
    if (requestCount % 250 === 0 || hits.size > 10_000) {
      for (const [storedKey, value] of hits) {
        if (value.resetAt <= now) hits.delete(storedKey);
      }
      while (hits.size > 10_000) hits.delete(hits.keys().next().value);
    }
    const current = hits.get(key);
    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um pouco e tente novamente.' });
    }
    return next();
  };
}

const reviewSubmissionRateLimit = simpleRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  keyPrefix: 'avaliacoes',
});

// ── CORS: permite seu frontend chamar o backend ──────────
app.use(cors({
  origin(origin, callback) {
    const localDevOrigin = !isProduction && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || '');
    if (!origin || allowedOrigins.has(origin) || localDevOrigin) return callback(null, true);
    const error = new Error('Origem nao permitida pelo CORS.');
    error.status = 403;
    error.expose = true;
    return callback(error);
  },
  methods: ['GET','POST','PUT','PATCH','DELETE'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ── Webhook do MP precisa do body RAW (antes do json()) ──
app.use('/api/webhook/mercadopago', simpleRateLimit({ windowMs: 60 * 1000, max: 120, keyPrefix: 'webhook' }));
app.use('/api/webhook', express.raw({ type: 'application/json', limit: '256kb' }));

// Uploads grandes só são processados depois de autenticar o administrador.
app.use('/api/produtos/upload-image', requireAdmin, express.json({ limit: '45mb' }));

// ── JSON para todas as outras rotas ─────────────────────
app.use(express.json({ limit: '1mb' }));

app.use('/api/auth/login', simpleRateLimit({ windowMs: 15 * 60 * 1000, max: 8, keyPrefix: 'login' }));
app.use('/api/pagamento/criar', simpleRateLimit({ windowMs: 60 * 1000, max: 12, keyPrefix: 'pagamento' }));
app.use('/api/pedidos/acompanhar', simpleRateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'acompanhar' }));
app.use('/api/pedidos/confirmacao', simpleRateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'confirmacao' }));
app.use('/api/engajamento/avaliacoes', (req, res, next) => {
  // A listagem e publica e acontece enquanto a pagina do produto atualiza.
  // O limite protege apenas o envio de comentarios.
  if (req.method !== 'POST') return next();
  return reviewSubmissionRateLimit(req, res, next);
});
app.use('/api/engajamento/metricas', simpleRateLimit({ windowMs: 60 * 1000, max: 90, keyPrefix: 'metricas' }));
app.use('/api/engajamento/vitrines', simpleRateLimit({ windowMs: 60 * 1000, max: 60, keyPrefix: 'vitrines' }));

if (!isAdminAuthConfigured()) {
  console.warn('Aviso: configure SENHA_ADMIN e SUPABASE_KEY; ADMIN_TOKEN_SECRET de 32+ caracteres e recomendado.');
}

// ── ROTAS ────────────────────────────────────────────────
app.use('/api/pagamento', pagamentoRoutes);
app.use('/api/pedidos',   pedidoRoutes);
app.use('/api/webhook',   webhookRoutes);
app.use('/api/auth',      authRoutes);
app.use('/api/produtos',  produtosRoutes);
app.use('/api/admin',     pedidosAdminRoutes);
app.use('/api/engajamento', engajamentoRoutes);

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'R Street Backend', time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'R Street Backend', time: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ erro: 'Rota nao encontrada.', referencia: req.requestId || undefined });
});

// ── ERROR HANDLER ────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
  console.error(`Erro ${req.requestId || '-'}:`, err.message);
  const publicMessage = err.expose === true
    ? (err.message || 'Requisicao invalida.')
    : status < 500
      ? 'Nao foi possivel concluir a solicitacao.'
      : 'Erro interno. Tente novamente em alguns instantes.';
  res.status(status).json({ erro: publicMessage, referencia: req.requestId || undefined });
});

app.listen(PORT, () => {
  require('./services/reservas').iniciarReconciliacaoReservas();
  console.log(`✅ R Street Backend rodando na porta ${PORT}`);
});
