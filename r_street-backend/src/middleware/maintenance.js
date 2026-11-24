'use strict';

function operationStatus(env = process.env) {
  return {
    checkoutMaintenance: env.CHECKOUT_MAINTENANCE === 'true',
    migrationWriteLock: env.MIGRATION_WRITE_LOCK === 'true',
  };
}

function maintenanceGuard(req, res, next) {
  const status = operationStatus();
  const path = req.path.toLowerCase().replace(/\/+$/, '') || '/';
  const checkout = path === '/api/pagamento/criar';
  const read = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  // Existing payments must still settle; tracking and login do not create sales.
  const essential = req.method === 'POST' && [
    '/api/auth/login', '/api/pedidos/acompanhar', '/api/pedidos/confirmacao',
    '/api/webhook/mercadopago',
  ].includes(path);
  if ((!status.checkoutMaintenance || !checkout) &&
      (!status.migrationWriteLock || read || essential)) return next();
  res.set({ 'Cache-Control': 'no-store', 'Retry-After': '3600' });
  return res.status(503).json({
    erro: 'A loja online esta em manutencao. Tente novamente mais tarde ou fale conosco pelo WhatsApp.',
    code: 'STORE_MAINTENANCE',
  });
}

module.exports = { maintenanceGuard, operationStatus };
