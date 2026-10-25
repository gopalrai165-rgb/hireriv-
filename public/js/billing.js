// Employer billing: opens the payment provider's window for an order the
// server created, then hands the provider's answer back to the server, which
// checks the signature and confirms the payment with the provider before
// anything changes. Nothing here is trusted on its own.
(() => {
  const status = document.getElementById('pay-status');
  const say = (text) => {
    if (status) { status.textContent = text; status.className = 'notice'; status.classList.remove('sr-only'); status.scrollIntoView({ block: 'nearest' }); }
  };
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
    .then((r) => r.json().then((data) => ({ status: r.status, data })).catch(() => ({ status: r.status, data: {} })));
  const done = (msg) => { window.location.href = `/employer/billing?msg=${encodeURIComponent(msg)}`; };

  document.querySelectorAll('[data-pay]').forEach((btn) => btn.addEventListener('click', async () => {
    let what;
    try { what = JSON.parse(btn.dataset.pay); } catch (e) { return; }
    btn.disabled = true;
    say('Preparing your payment…');
    const order = await post('/api/billing/checkout', what);
    if (!order.data.ok) { btn.disabled = false; say((order.data.errors || ['Could not start the payment']).join('. ')); return; }
    const o = order.data;
    if (typeof window.Razorpay !== 'function') { btn.disabled = false; say('The payment window could not load. Check your connection and try again.'); return; }
    const rzp = new window.Razorpay({
      key: o.key, order_id: o.orderId, amount: o.amountPaise, currency: o.currency, name: o.name, description: o.description, prefill: o.prefill,
      handler: async (resp) => {
        say('Confirming your payment…');
        const v = await post('/api/billing/checkout/verify', { orderId: resp.razorpay_order_id, paymentId: resp.razorpay_payment_id, signature: resp.razorpay_signature });
        if (v.data.ok && v.data.status === 'paid') done('Payment received. Thank you!');
        else if (v.data.status === 'pending' || v.status === 202) done('Your payment is being confirmed by the bank. This page will show it once it is confirmed.');
        else { btn.disabled = false; say((v.data.errors || ['We could not confirm this payment. If money left your account, it will be matched or returned automatically.']).join('. ')); }
      },
      modal: { ondismiss: () => { btn.disabled = false; say('Payment window closed. Nothing was charged.'); } },
    });
    rzp.on('payment.failed', (resp) => { btn.disabled = false; say(`Payment failed: ${(resp.error && resp.error.description) || 'please try again'}. Nothing was charged.`); });
    rzp.open();
  }));
})();
