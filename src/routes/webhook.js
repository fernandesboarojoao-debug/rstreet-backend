// src/routes/webhook.js
const express = require('express');
const { receberWebhook } = require('../controllers/webhookController');
const router = express.Router();

// POST /api/webhook/mercadopago
router.post('/mercadopago', receberWebhook);

module.exports = router;
