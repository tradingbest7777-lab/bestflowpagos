require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');

const app = express();
app.use(helmet());
app.use(express.json());
app.use(cors({
  origin: [process.env.FRONTEND_URL, 'https://bestflowtba.com'],
  methods: ['GET', 'POST', 'PATCH']
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ============================================================================
// 1. CATÁLOGO OFICIAL DE TRADING BEST / BESTFLOW (Precios protegidos en backend)
// ============================================================================
const CATALOG = {
  'PROMO_1_USD': { name: 'Promo Exclusiva Best Flow ($1)', amount: 1.00, planType: 'MONTHLY', days: 30 },
  'CURSO_FOREX': { name: 'Curso de Forex (Básico a Avanzado)', amount: 400.00, planType: 'ONE_TIME', days: 365 },
  'CURSO_SINTETICOS': { name: 'Curso de Índices Sintéticos', amount: 450.00, planType: 'ONE_TIME', days: 365 },
  'CURSO_CRIPTO': { name: 'Curso de Criptoactivos', amount: 350.00, planType: 'ONE_TIME', days: 365 },
  'CURSO_OPCIONES': { name: 'Curso de Opciones', amount: 300.00, planType: 'ONE_TIME', days: 365 },
  'CURSO_ARBITRAJE': { name: 'Curso de Arbitraje Cripto', amount: 600.00, planType: 'ONE_TIME', days: 365 },
  'ASESORIA_FINANCIERA': { name: 'Asesoría Financiera Personalizada', amount: 500.00, planType: 'ONE_TIME', days: 90 },
  'HACK_TICKET': { name: 'Hack Ticket Forex + Sintéticos (35% OFF)', amount: 3250.00, planType: 'ONE_TIME', days: 365 },
  'KIT_BESTFLOW_MENSUAL': { name: 'Kit Best Flow - Plan Mensual', amount: 49.00, planType: 'MONTHLY', days: 30 },
  'KIT_BESTFLOW_TRIMESTRAL': { name: 'Kit Best Flow - Plan Trimestral', amount: 129.00, planType: 'QUARTERLY', days: 90 },
  'KIT_BESTFLOW_SEMESTRAL': { name: 'Kit Best Flow - Plan Semestral', amount: 239.00, planType: 'SEMIANNUAL', days: 180 }
};

// ============================================================================
// 2. GENERADOR DE AUTENTICACIÓN WSSE PARA PLACETOPAY
// ============================================================================
function buildPlacetopayAuth() {
  const login = process.env.PLACETOPAY_LOGIN;
  const secretKey = process.env.PLACETOPAY_TRANKEY;
  const rawNonce = crypto.randomBytes(16);
  const nonceBase64 = rawNonce.toString('base64');
  const seed = new Date().toISOString();

  // tranKey = Base64(SHA-256(rawNonce + seed + secretKey))
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.concat([rawNonce, Buffer.from(seed, 'utf8'), Buffer.from(secretKey, 'utf8')]));
  const tranKey = hash.digest('base64');

  return { login, tranKey, nonce: nonceBase64, seed };
}

// ============================================================================
// 3. CREAR SESIÓN DE PAGO EN PLACETOPAY CHECKOUT
// ============================================================================
app.post('/api/checkout/create', async (req, res) => {
  try {
    const { productCode, buyerName, buyerEmail, buyerPhone, country } = req.body;

    if (!productCode || !CATALOG[productCode]) {
      return res.status(400).json({ error: 'Producto no válido en el catálogo.' });
    }
    if (!buyerName || !buyerEmail) {
      return res.status(400).json({ error: 'Nombre y correo electrónico son obligatorios.' });
    }

    const product = CATALOG[productCode];
    const cleanEmail = buyerEmail.trim().toLowerCase();

    // Evitar órdenes duplicadas pendientes del mismo usuario y producto en los últimos 10 min
    const existing = await pool.query(
      `SELECT reference, process_url FROM bf_orders 
       WHERE buyer_email = $1 AND product_code = $2 AND status = 'PENDING' 
       AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1`,
      [cleanEmail, productCode]
    );

    if (existing.rows.length > 0 && existing.rows[0].process_url) {
      return res.json({
        reference: existing.rows[0].reference,
        processUrl: existing.rows[0].process_url,
        reused: true
      });
    }

    const reference = `TB-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const expiration = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min para pagar
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim();

    const payload = {
      locale: 'es_PA',
      auth: buildPlacetopayAuth(),
      buyer: {
        name: buyerName.trim(),
        email: cleanEmail,
        mobile: buyerPhone || ''
      },
      payment: {
        reference,
        description: `${product.name} - Trading Best / BestFlow`,
        amount: {
          currency: 'USD',
          total: product.amount
        },
        allowPartial: false
      },
      expiration,
      returnUrl: `${process.env.FRONTEND_URL}/?payment_ref=${reference}`,
      cancelUrl: `${process.env.FRONTEND_URL}/?payment_cancelled=${reference}`,
      notificationUrl: `${process.env.BRIDGE_PUBLIC_URL}/api/webhooks/placetopay`,
      ipAddress: clientIp,
      userAgent: req.headers['user-agent'] || 'BestFlow-Client'
    };

    const p2pResponse = await fetch(`${process.env.PLACETOPAY_BASE_URL}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await p2pResponse.json();

    if (!data.status || data.status.status !== 'OK') {
      await pool.query(
        `INSERT INTO bf_payment_logs (reference, event_type, status_reported, raw_payload) VALUES ($1, $2, $3, $4)`,
        [reference, 'SESSION_CREATE_ERROR', data.status?.status || 'ERROR', JSON.stringify(data)]
      );
      return res.status(502).json({ error: 'No se pudo iniciar la sesión con Placetopay.', detail: data.status?.message });
    }

    await pool.query(
      `INSERT INTO bf_orders 
       (reference, buyer_name, buyer_email, buyer_phone, country, product_code, product_name, plan_type, amount, currency, placetopay_request_id, process_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USD', $10, $11, 'PENDING')`,
      [reference, buyerName.trim(), cleanEmail, buyerPhone || '', country || 'Panamá', productCode, product.name, product.planType, product.amount, data.requestId, data.processUrl]
    );

    res.json({
      reference,
      requestId: data.requestId,
      processUrl: data.processUrl
    });

  } catch (err) {
    console.error('Error en /api/checkout/create:', err.message);
    res.status(500).json({ error: 'Error interno al generar el pago.' });
  }
});

// ============================================================================
// 4. ACTIVACIÓN IDEMPOTENTE Y CONSULTA REAL A PLACETOPAY
// ============================================================================
async function syncAndActivateOrder(requestId) {
  const verifyRes = await fetch(`${process.env.PLACETOPAY_BASE_URL}/api/session/${requestId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth: buildPlacetopayAuth() })
  });

  const sessionData = await verifyRes.json();
  const realStatus = sessionData.status?.status; // APPROVED, REJECTED, PENDING, EXPIRED
  const reference = sessionData.request?.payment?.reference;

  await pool.query(
    `INSERT INTO bf_payment_logs (reference, request_id, event_type, status_reported, raw_payload) VALUES ($1, $2, $3, $4, $5)`,
    [reference || 'UNKNOWN', requestId, 'SESSION_SYNC', realStatus || 'UNKNOWN', JSON.stringify(sessionData)]
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      `SELECT * FROM bf_orders WHERE placetopay_request_id = $1 FOR UPDATE`,
      [requestId]
    );

    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { found: false };
    }

    const order = orderRes.rows[0];

    if (order.webhook_processed && order.status === 'APPROVED') {
      await client.query('COMMIT');
      return { found: true, status: 'APPROVED', alreadyProcessed: true, order };
    }

    const paymentTx = Array.isArray(sessionData.payment) && sessionData.payment.length > 0
      ? sessionData.payment[0]
      : null;

    if (realStatus === 'APPROVED' && paymentTx) {
      const paidAmount = Number(paymentTx.amount?.from?.total || paymentTx.amount?.to?.total || 0);
      const paidCurrency = paymentTx.amount?.from?.currency || 'USD';

      if (paidAmount < Number(order.amount) || paidCurrency !== 'USD') {
        await client.query('ROLLBACK');
        throw new Error(`Discrepancia de monto/moneda en orden ${order.reference}`);
      }
    }

    await client.query(
      `UPDATE bf_orders 
       SET status = $1, 
           authorization_code = $2, 
           payment_method = $3, 
           receipt_number = $4,
           webhook_processed = $5,
           updated_at = NOW()
       WHERE id = $6`,
      [
        realStatus,
        paymentTx?.authorization || null,
        paymentTx?.paymentMethodName || null,
        paymentTx?.receipt || null,
        realStatus === 'APPROVED',
        order.id
      ]
    );

    if (realStatus === 'APPROVED') {
      const catalogItem = CATALOG[order.product_code];
      const daysToAdd = catalogItem ? catalogItem.days : 30;
      const startDate = new Date();
      const endDate = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000);

      await client.query(
        `INSERT INTO bf_subscriptions 
         (user_email, buyer_name, product_code, product_name, billing_cycle, amount, status, start_date, end_date, last_order_reference)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9)`,
