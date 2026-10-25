// Payment providers behind one small interface, so the billing code never
// talks to a gateway directly. Razorpay is built in (its test mode is the
// sandbox); another gateway (e.g. Cashfree) is a new entry in PROVIDERS.
//
// Secrets stay on the server: the browser only ever gets the public key id
// and an order id. A payment counts only after the server has checked its
// signature AND fetched the payment from the provider's API (a redirect or a
// browser callback alone proves nothing). Webhooks are checked against the
// exact bytes received with the webhook secret.
const crypto = require('crypto');

const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
// Constant-time comparison of two hex signatures.
function sameSig(expected, given) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(given || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Payment states in our words. Razorpay: created → authorized → captured
// (or failed); refunds and disputes come later as their own events.
const RAZORPAY_STATUS = { created: 'pending', authorized: 'pending', captured: 'paid', failed: 'failed', refunded: 'refunded' };

function razorpay(env, { fetchImpl = fetch } = {}) {
  const keyId = env.RAZORPAY_KEY_ID || '';
  const keySecret = env.RAZORPAY_KEY_SECRET || '';
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET || '';
  const base = (env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  async function call(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The provider's message, never our key or the request.
      const err = new Error(`Razorpay ${method} ${path.split('/')[1]} failed (${res.status}): ${(data.error && data.error.description) || 'no details'}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  // Only the fields billing needs: no email, phone or card details are kept.
  const payment = (p) => ({
    id: p.id, orderId: p.order_id || null, amountPaise: Number(p.amount), currency: p.currency, status: RAZORPAY_STATUS[p.status] || 'pending',
    providerStatus: p.status, method: p.method || '', refundedPaise: Number(p.amount_refunded || 0),
    error: p.status === 'failed' ? String(p.error_description || p.error_reason || 'Payment failed').slice(0, 200) : '',
  });

  return {
    name: 'razorpay',
    label: 'Razorpay',
    ready: Boolean(keyId && keySecret),
    webhooks: Boolean(webhookSecret),
    // Test-mode keys (rzp_test_…) are Razorpay's sandbox.
    sandbox: /^rzp_test_/.test(keyId),
    // Safe to send to the browser: the public key id and nothing else.
    publicKey: keyId,
    checkoutScript: 'https://checkout.razorpay.com/v1/checkout.js',
    async createOrder({ amountPaise, currency, receipt, notes }) {
      const o = await call('POST', '/orders', { amount: amountPaise, currency, receipt: String(receipt).slice(0, 40), notes });
      return { id: o.id, amountPaise: Number(o.amount), currency: o.currency };
    },
    fetchPayment: async (id) => payment(await call('GET', `/payments/${encodeURIComponent(id)}`)),
    orderPayments: async (orderId) => ((await call('GET', `/orders/${encodeURIComponent(orderId)}/payments`)).items || []).map(payment),
    async refund(paymentId, { amountPaise, notes }) {
      const r = await call('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountPaise, notes });
      return { id: r.id, status: r.status === 'processed' ? 'processed' : r.status === 'failed' ? 'failed' : 'processing' };
    },
    // The checkout handler's signature: HMAC(order_id|payment_id, key secret).
    verifyCheckout: ({ orderId, paymentId, signature }) => Boolean(keySecret && orderId && paymentId) && sameSig(hmac(keySecret, `${orderId}|${paymentId}`), signature),
    verifyWebhook: (raw, headers) => Boolean(webhookSecret && raw) && sameSig(hmac(webhookSecret, raw), headers['x-razorpay-signature']),
    // A verified webhook as one event in our words.
    parseWebhook(body, headers) {
      const pl = (body && body.payload) || {};
      const p = pl.payment && pl.payment.entity;
      const r = pl.refund && pl.refund.entity;
      const d = pl.dispute && pl.dispute.entity;
      const type = String(body.event || '');
      // Razorpay sends a unique id per event; retries repeat it.
      const fallback = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32);
      return {
        eventId: String(headers['x-razorpay-event-id'] || fallback).slice(0, 80),
        type,
        kind: /^payment\.(captured|authorized|failed)$/.test(type) || type === 'order.paid' ? 'payment'
          : /^refund\.(processed|failed|created)$/.test(type) ? 'refund'
          : /^payment\.dispute\./.test(type) ? 'dispute' : 'other',
        payment: p ? payment(p) : null,
        refund: r ? { id: r.id, paymentId: r.payment_id, amountPaise: Number(r.amount), status: r.status === 'processed' ? 'processed' : r.status === 'failed' ? 'failed' : 'processing' } : null,
        dispute: d ? { id: d.id, paymentId: d.payment_id, amountPaise: Number(d.amount), status: type.replace('payment.dispute.', ''), reason: String(d.reason_code || '').slice(0, 80) } : null,
      };
    },
  };
}

// No gateway configured: billing pages still work, online payment is off.
const none = () => ({ name: 'none', label: 'Not set up', ready: false, webhooks: false, sandbox: false, publicKey: '' });

const PROVIDERS = { razorpay };

function fromEnv(env = process.env, opts = {}) {
  const name = String(env.PAYMENTS_PROVIDER || (env.RAZORPAY_KEY_ID ? 'razorpay' : 'none')).toLowerCase();
  return PROVIDERS[name] ? PROVIDERS[name](env, opts) : none();
}

module.exports = { fromEnv, PROVIDERS, hmac, sameSig };
