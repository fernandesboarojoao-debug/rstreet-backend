require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors    = require('cors');

const pagamentoRoutes    = require('./routes/pagamento');
const pedidoRoutes       = require('./routes/pedidos');
const webhookRoutes      = require('./routes/webhook');
const authRoutes         = require('./routes/auth');
const produtosRoutes     = require('./routes/produtos');
const pedidosAdminRoutes = require('./routes/pedidosAdmin');

const app  = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = new Set([
  process.env.FRONTEND_URL,
  'https://rstreet.com.br',
  'https://www.rstreet.com.br',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
].filter(Boolean));

function simpleRateLimit({ windowMs, max, keyPrefix }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const current = hits.get(key);
    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um pouco e tente novamente.' });
    }
    return next();
  };
}

// ── CORS: permite seu frontend chamar o backend ──────────
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origem nao permitida pelo CORS.'));
  },
  methods: ['GET','POST','PUT','PATCH','DELETE'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ── Webhook do MP precisa do body RAW (antes do json()) ──
app.use('/api/webhook', express.raw({ type: 'application/json' }));

// ── JSON para todas as outras rotas ─────────────────────
app.use(express.json({ limit: '50mb' }));

app.use('/api/auth/login', simpleRateLimit({ windowMs: 15 * 60 * 1000, max: 8, keyPrefix: 'login' }));
app.use('/api/pagamento/criar', simpleRateLimit({ windowMs: 60 * 1000, max: 12, keyPrefix: 'pagamento' }));
app.use('/api/pedidos/acompanhar', simpleRateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'acompanhar' }));

// ── ROTAS ────────────────────────────────────────────────
app.use('/api/pagamento', pagamentoRoutes);
app.use('/api/pedidos',   pedidoRoutes);
app.use('/api/webhook',   webhookRoutes);
app.use('/api/auth',      authRoutes);
app.use('/api/produtos',  produtosRoutes);
app.use('/api/admin',     pedidosAdminRoutes);

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'R Street Backend', time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'R Street Backend', time: new Date().toISOString() });
});

// ── ERROR HANDLER ────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Erro:', err.message);
  res.status(err.status || 500).json({ erro: err.message || 'Erro interno' });
});

app.listen(PORT, () => {
  console.log(`✅ R Street Backend rodando na porta ${PORT}`);
});
