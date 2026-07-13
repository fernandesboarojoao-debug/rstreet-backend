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

// ── CORS: permite seu frontend chamar o backend ──────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'https://rstreet.com.br',
    'https://www.rstreet.com.br',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    /\.netlify\.app$/,
  ],
  methods: ['GET','POST','PUT','PATCH','DELETE'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ── Webhook do MP precisa do body RAW (antes do json()) ──
app.use('/api/webhook', express.raw({ type: 'application/json' }));

// ── JSON para todas as outras rotas ─────────────────────
app.use(express.json({ limit: '8mb' }));

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

// ── ERROR HANDLER ────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Erro:', err.message);
  res.status(err.status || 500).json({ erro: err.message || 'Erro interno' });
});

app.listen(PORT, () => {
  console.log(`✅ R Street Backend rodando na porta ${PORT}`);
});
