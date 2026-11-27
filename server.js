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
  origin: [process.env.FRONTEND_URL, 'https://bestflowtba.com', 'null'],
  methods: ['GET', 'POST', 'PATCH']
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ============================================================================
// 1. CATÁLOGO OFICIAL DE TRADING BEST / BESTFLOW
// ============================================================================
const CATALOG = {
  'PROMO_1_USD': { name: 'Promo Exclusiva Best Flow ($1)', amount: 1.00, planType: 'MONTHLY', days: 30, accessUrl: 'https://bestflowtba.com' },
  'CURSO_FOREX': { name: 'Curso de Forex (Básico a Avanzado)', amount: 400.00, planType: 'ONE_TIME', days: 365, accessUrl: 'https://bestflowtba.com' },
  'CURSO_SINTETICOS': { name: 'Curso de Índices Sintéticos', amount: 450.00, planType: 'ONE_TIME', days: 365, accessUrl: 'https://bestflowtba.com' },
  'CURSO_CRIPTO': { name: 'Curso de Criptoactivos', amount: 350.00, planType: 'ONE_TIME', days: 365, accessUrl: 'https://bestflowtba.com' },
  'CURSO_OPCIONES': { name: 'Curso de Opciones', amount: 300.00, planType: 'ONE_TIME', days: 365, accessUrl: 'https://bestflowtba.com' },
  'CURSO_ARBITRAJE': { name: 'Curso de Arbitraje Cripto', amount: 600.00, planType: 'ONE_TIME', days: 365, accessUrl: 'https://bestflowtba.com' },
  'ASESORIA_FINANCIERA': { name: 'Asesoría Financiera Personalizada', amount: 500.00, planType: 'ONE_TIME', days: 90, accessUrl: 'https://bestflowtba.com' },
  'HACK_TICKET': { name: 'Hack Ticket Forex + Sintéticos (35% OFF)', amount: 3250.00, planType: 'ONE_TIME', days: 365, accessUrl: 'https://bestflowtba.com' },
  'KIT_BESTFLOW_MENSUAL': { name: 'Kit Best Flow - Plan Mensual', amount: 49.00, planType: 'MONTHLY', days: 30, accessUrl: 'https://bestflowtba.com' },
  'KIT_BESTFLOW_TRIMESTRAL': { name: 'Kit Best Flow - Plan Trimestral', amount: 129.00, planType: 'QUARTERLY', days: 90, accessUrl: 'https://bestflowtba.com' },
  'KIT_BESTFLOW_SEMESTRAL': { name: 'Kit Best Flow - Plan Semestral', amount: 239.00, planType: 'SEMIANNUAL', days: 180, accessUrl: 'https://bestflowtba.com' }
};

// ============================================================================
// 2. FUNCIÓN DE ENVÍO DE CORREO AUTOMÁTICO (RESEND)
// ============================================================================
async function sendWelcomeAndReceiptEmail(order, endDate) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY no configurada; omitiendo correo para', order.reference);
    return;
  }

  const catalogItem = CATALOG[order.product_code] || { accessUrl: process.env.FRONTEND_URL };
  const formattedEnd = new Date(endDate).toLocaleDateString('es-PA', { year: 'numeric', month: 'long', day: 'numeric' });

  const htmlBody = `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;background:#0f172a;color:#f8fafc;padding:32px;border-radius:16px;border:1px solid #1e293b;">
    <h2 style="color:#38bdf8;margin-top:0;">¡Pago Confirmado y Acceso Activado!</h2>
    <p>Hola <strong>${order.buyer_name}</strong>,</p>
    <p>Hemos recibido tu pago de forma exitosa a través de <strong>Placetopay · Caja de Ahorros de Panamá</strong>. Aquí tienes tu comprobante oficial:</p>
    
    <div style="background:#1e293b;padding:18px;border-radius:12px;margin:20px 0;border:1px solid #334155;">
      <p style="margin:4px 0;"><strong>Referencia:</strong> ${order.reference}</p>
      <p style="margin:4px 0;"><strong>Programa / Plan:</strong> ${order.product_name}</p>
      <p style="margin:4px 0;"><strong>Monto Pagado:</strong> $${Number(order.amount).toFixed(2)} USD</p>
      <p style="margin:4px 0;"><strong>Código de Autorización:</strong> ${order.authorization_code || 'Confirmado'}</p>
      <p style="margin:4px 0;"><strong>Vigencia hasta:</strong> ${formattedEnd}</p>
    </div>

    <p>Ya puedes ingresar a tu portal de estudiante con tu correo <strong>${order.buyer_email}</strong>:</p>
    <a href="${catalogItem.accessUrl}" style="display:inline-block;padding:14px 24px;background:#0284c7;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;margin:10px 0;">
      Ingresar a Mi Panel TraderTB
    </a>

    <p style="font-size:12px;color:#94a3b8;margin-top:24px;">
      Si necesitas asistencia inmediata, escríbenos por WhatsApp al +507 6404-9613.<br>
      Trading Best Oficial • República de Panamá.
    </p>
  </div>`;

  try {
    await fetch('https://resend.com', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'Trading Best <onboarding@resend.dev>',
        to: [order.buyer_email],
        subject: `Recibo Oficial y Acceso Activo — ${order.product_name} (${order.reference})`,
        html: htmlBody
      })
    });
  } catch (emailErr) {
    console.error('Error enviando correo con Resend:', emailErr.message);
  }
}

// ============================================================================
// 3. GENERADOR DE AUTENTICACIÓN WSSE PARA PLACETOPAY
// ============================================================================
function buildPlacetopayAuth() {
  const login = process.env.PLACETOPAY_LOGIN;
  const secretKey = process.env.PLACETOPAY_TRANKEY;
  const rawNonce = crypto.randomBytes(16);
  const nonceBase64 = rawNonce.toString('base64');
  const seed = new Date().toISOString();

  const hash = crypto.createHash('sha256');
  hash.update(Buffer.concat([rawNonce, Buffer.from(seed, 'utf8'), Buffer.from(secretKey, 'utf8')]));
  const tranKey = hash.digest('base64');

  return { login, tranKey, nonce: nonceBase64, seed };
}

// ============================================================================
// 4. CREAR SESIÓN DE PAGO EN PLACETOPAY CHECKOUT
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
    const expiration = new Date(Date.now() + 30 * 60 * 1000).toISOString();
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

