// Payments, subscriptions and billing pages (Step 63): employer checkout and
// billing dashboard, the payment provider's webhooks, renewals and reminders,
// refunds with a second person's approval, reconciliation and the team's
// billing desk. The rules for plans, limits, quotes and invoices are in
// subscriptions.js; the payment provider is behind payment-gateway.js.
const crypto = require('crypto');
const S = require('./subscriptions');
const { amountInWords, formatYmd, billingOf } = require('./placements');

const { inr, rupees, addDays, daysBetween, addInterval, todayIst, perMonth, SETTLED } = S;
const iso = () => new Date().toISOString();
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

function register(app, deps) {
  const { db, site, mailer, notify, store, gateway, team, clients, placements, getJobs, adminAuth, sameOrigin, limit, requireConfirmed, trust, baseUrl, sendCsv, ops } = deps;
  const { requireEmployer, requireEmployerApi } = clients;
  const { TXNS, INVOICES, REFUNDS, EVENTS, SUBS } = store;
  const { find, put, add } = store;
  const employerById = (id) => clients.read().find((e) => e.id === id) || null;
  const can = (req, action) => S.agencyRoles.can(req.admin, action);
  const ACTIVE_JOBS = ['open', 'paused', 'pending'];

  // ---------- who hears about a company's billing ----------
  // Owners and billing administrators with a confirmed email, plus the billing contact.
  function billingPeople(emp) {
    return clients.team.membersOf(emp.id).filter((m) => S.employerCan(m, 'billing.view'))
      .map((m) => clients.team.userById(m.userId)).filter((u) => u && u.active && u.emailVerifiedAt);
  }
  function tellCompany(emp, key, { title, body, subject, intro, rows = [], link = '/employer/billing' }) {
    const people = billingPeople(emp);
    try {
      notify.emit({ key, type: 'billing', to: people.map((u) => ({ kind: 'employer', userId: u.id, employerId: emp.id })), inApp: { title, body, link, perm: 'billing.view' } });
    } catch (e) { console.error('Billing notification:', e.message); }
    const emails = new Map(people.map((u) => [u.email, { name: u.name, email: u.email, kind: 'employer' }]));
    const p = store.profileOf(emp);
    if (p.contactEmail && !emails.has(p.contactEmail)) emails.set(p.contactEmail, { name: p.contactName || emp.company, email: p.contactEmail, kind: 'employer' });
    for (const who of emails.values()) {
      Promise.resolve(mailer.notice(who, { subject, heading: title, intro, rows, link: `${baseUrl}${link}`, label: 'Open billing' })).catch((e) => console.error('Billing email:', e.message));
    }
  }
  // The finance side of the team (refunds to approve, disputes, mismatches).
  function tellFinance(key, title, body, link = '/admin/billing') {
    const to = team.members().filter((u) => u.active !== false && S.agencyRoles.can(u, 'billing.refund')).map((u) => ({ kind: 'team', userId: u.id }));
    try { notify.emit({ key, type: 'billing', to, inApp: { title, body, link } }); } catch (e) { console.error('Billing notification:', e.message); }
  }

  // ---------- views of records ----------
  const usageOf = (emp) => ({
    jobs: getJobs().filter((j) => j.employerId === emp.id && ACTIVE_JOBS.includes(j.status)).length,
    seats: clients.team.membersOf(emp.id).length,
  });
  function subscriptionJson(emp) {
    const { sub, plan, managed } = store.currentPlan(emp);
    const next = sub && sub.nextPlanId ? store.planById(sub.nextPlanId) : null;
    const s = store.settings();
    const renewable = renewalPlan(emp);
    return {
      plan: plan ? store.publicPlan(plan) : null,
      managed: Boolean(managed),
      status: sub ? sub.status : managed ? 'managed' : 'active',
      periodStart: sub ? sub.periodStart || null : null,
      // The day the plan renews (or ends, when cancelled).
      renewsOn: sub && sub.periodEnd && !sub.cancelAtPeriodEnd ? sub.periodEnd : null,
      endsOn: sub && sub.periodEnd && sub.cancelAtPeriodEnd ? sub.periodEnd : null,
      cancelAtPeriodEnd: Boolean(sub && sub.cancelAtPeriodEnd),
      graceEnds: sub && sub.status === 'past_due' ? sub.graceEnds : null,
      nextPlan: next ? { id: next.id, name: next.name } : null,
      limits: store.limitsOf(emp),
      usage: usageOf(emp),
      renewal: renewable ? { planId: renewable.plan.id, amountPaise: renewable.q.totalPaise, display: inr(renewable.q.totalPaise), from: renewable.q.period.from } : null,
      graceDays: s.graceDays,
      payments: { provider: gateway.name, online: gateway.ready, sandbox: Boolean(gateway.sandbox) },
    };
  }
  const invoiceJson = (inv) => ({
    id: inv.id, number: inv.number, kind: inv.kind, date: inv.date, dueDate: inv.dueDate, status: inv.status, currency: inv.currency,
    period: inv.period, lines: inv.lines.map((l) => ({ text: l.text, sac: l.sac || null, amountPaise: l.amountPaise })),
    subtotalPaise: inv.subtotalPaise, gstPercent: inv.gstPercent, taxLines: inv.taxLines, taxPaise: inv.taxPaise, totalPaise: inv.totalPaise,
    balancePaise: store.balanceOf(inv), buyer: inv.buyer, seller: { name: inv.seller.name, gstin: inv.seller.gstin, stateName: inv.seller.stateName },
    payments: (inv.payments || []).map((p) => ({ date: p.date, amountPaise: p.amountPaise, mode: p.mode, reference: p.reference })),
    creditNotes: (inv.creditNotes || []).map((c) => ({ id: c.id, number: c.number, date: c.date, totalPaise: c.totalPaise, reason: c.reason })),
    url: `/employer/billing/invoices/${inv.id}`,
  });
  const txnJson = (t) => ({
    id: t.id, purpose: t.purpose, status: t.status, amountPaise: t.amountPaise, currency: t.currency, provider: t.provider,
    orderId: t.orderId, paymentId: t.paymentId || null, method: t.method || null, createdAt: t.createdAt, paidAt: t.paidAt || null,
    failure: t.failure || null, refundedPaise: t.refundedPaise || 0, invoiceId: t.resultInvoiceId || t.invoiceId || null,
    receipt: SETTLED.includes(t.status) ? `/employer/billing/receipts/${t.id}` : null,
  });
  // The shape invoice.ejs prints (amounts in rupees), from a record kept in paise.
  function invoiceView(inv) {
    const cnView = (c) => ({ ...c, subtotal: rupees(c.subtotalPaise), total: rupees(c.totalPaise), taxLines: c.taxLines.map((t) => ({ label: t.label, amount: rupees(t.amountPaise) })) });
    const paidAt = (inv.payments || []).map((p) => p.date).sort().pop() || null;
    return {
      ...inv, paidAt, item: inv.lines[0] ? inv.lines[0].text : '', sac: (inv.lines.find((l) => l.sac) || {}).sac || '',
      lines: inv.lines.map((l) => ({ text: l.text, sac: l.sac || '', amount: rupees(l.amountPaise) })),
      subtotal: rupees(inv.subtotalPaise), total: rupees(inv.totalPaise), taxLines: inv.taxLines.map((t) => ({ label: t.label, amount: rupees(t.amountPaise) })),
      payments: (inv.payments || []).map((p) => ({ ...p, amount: rupees(p.amountPaise), tds: 0 })), creditNotes: (inv.creditNotes || []).map(cnView),
      footNote: inv.kind === 'package' ? 'This is a computer-generated invoice for recruitment services.' : 'This is a computer-generated invoice for a Hireriv employer plan.',
    };
  }
  const accountView = (inv) => ({ received: rupees(store.paidOf(inv)), tds: 0, credited: rupees(store.creditedOf(inv)), refunded: rupees(store.refundedOf(inv)), balance: rupees(store.balanceOf(inv)), refundDue: 0 });
  const renderInvoice = (res, inv, back, cnBase, cn = null) => {
    res.set('Cache-Control', 'no-store');
    const v = invoiceView(inv);
    res.render('invoice', {
      title: cn ? `Credit note ${cn.number}` : `Invoice ${inv.number}`, page: 'invoice', noindex: true,
      p: {}, inv: v, cn: cn ? v.creditNotes.find((c) => c.id === cn.id) : null, back, cnBase, acct: accountView(inv), inr: (n) => inr(Math.round(n * 100)), amountInWords, formatYmd,
    });
  };

  // ---------- renewals ----------
  // A paid plan can be renewed in its last days (or while overdue): for the
  // plan it moves to at renewal if one was chosen, otherwise the same plan.
  function renewalPlan(emp) {
    const sub = store.subOf(emp.id);
    if (!sub || !sub.periodEnd || sub.cancelAtPeriodEnd || !['active', 'past_due'].includes(sub.status)) return null;
    const window = Math.max(...store.settings().reminderDays, 7);
    if (sub.status === 'active' && daysBetween(todayIst(), sub.periodEnd) > window) return null;
    const plan = (sub.nextPlanId && store.planById(sub.nextPlanId)) || store.planById(sub.planId);
    if (!plan || !(plan.pricePaise > 0) || plan.kind !== 'subscription') return null;
    return { sub, plan, q: store.quote(emp, { purpose: 'renewal', plan, from: sub.periodEnd }) };
  }

  // ---------- checkout ----------
  // Works out what is being bought and what it costs; nothing is stored yet.
  function purchase(req, body) {
    const emp = req.employer;
    if (body.invoiceId) {
      const inv = find(INVOICES, 'id', clip(body.invoiceId, 60));
      if (!inv || inv.employerId !== emp.id) return { status: 404, error: 'invoice not found' };
      if (!['Unpaid', 'Part paid'].includes(inv.status) || !store.balanceOf(inv)) return { status: 409, error: 'this invoice has nothing left to pay' };
      return { purpose: 'invoice', invoiceId: inv.id, q: store.quote(emp, { purpose: 'invoice', invoice: inv }), label: `Invoice ${inv.number}` };
    }
    if (body.placementId) {
      // A staffing or placement invoice from the team (placements.js).
      const hit = placements.clientInvoice(emp, clip(body.placementId, 60), clip(body.invoice || 'main', 60));
      if (!hit) return { status: 404, error: 'invoice not found' };
      if (!(hit.balancePaise > 0)) return { status: 409, error: 'this invoice has nothing left to pay' };
      const q = { lines: [{ text: `Payment for invoice ${hit.number}`, sac: '', amountPaise: hit.balancePaise }], subtotalPaise: hit.balancePaise, gstPercent: 0, taxType: 'inter', taxLines: [], taxPaise: 0, totalPaise: hit.balancePaise, currency: S.CURRENCY, buyer: store.buyerOf(emp), period: null };
      return { purpose: 'placement-invoice', placementId: hit.placementId, invoiceKey: hit.key, q, label: `Invoice ${hit.number}` };
    }
    if (body.purpose === 'renewal') {
      const r = renewalPlan(emp);
      if (!r) return { status: 409, error: 'there is no renewal to pay right now' };
      return { purpose: 'renewal', planId: r.plan.id, q: r.q, label: `${r.plan.name} plan renewal` };
    }
    const plan = store.planById(clip(body.planId, 60));
    if (!plan || !plan.active) return { status: 404, error: 'plan not found' };
    if (plan.custom) return { status: 409, error: 'this plan is quoted for each company: ask us for a quote on the Hire page' };
    if (plan.kind === 'package') return { purpose: 'package', planId: plan.id, q: store.quote(emp, { purpose: 'package', plan }), label: plan.name };
    if (!(plan.pricePaise > 0)) return { status: 409, error: 'the free plan needs no payment: choose it under Change plan' };
    const { sub, plan: cur, managed } = store.currentPlan(emp);
    if (managed && !sub) return { status: 409, error: 'your account is billed by your Hireriv account manager; ask them to change your plan' };
    if (cur && cur.id === plan.id && sub && sub.periodEnd && sub.status === 'active') return { status: 409, error: 'you are already on this plan; you can renew it in its last week' };
    const paidNow = cur && cur.pricePaise > 0 && sub && sub.status === 'active' && sub.periodEnd;
    if (paidNow && perMonth(plan) <= perMonth(sub.plan || cur)) return { status: 409, error: 'a smaller plan starts when your current period ends: use Change plan' };
    const credit = paidNow ? store.unusedCredit(sub) : null;
    if (credit && credit.amountPaise >= plan.pricePaise) return { status: 409, error: 'your unused time is worth more than this plan; contact us to change it' };
    return { purpose: 'plan', planId: plan.id, q: store.quote(emp, { purpose: 'plan', plan, credit }), label: `${plan.name} plan` };
  }

  async function checkout(req, body) {
    if (!gateway.ready) return { status: 503, error: 'online payment is not set up yet; contact us to pay by bank transfer' };
    const what = purchase(req, body || {});
    if (what.error) return what;
    if (what.q.totalPaise < 100) return { status: 409, error: 'the amount is too small to pay online' };
    const emp = req.employer;
    // A second click within 30 minutes gets the same order, not a new charge.
    const recent = db.where(TXNS, 'employerId', emp.id).find((t) => t.status === 'created' && t.purpose === what.purpose && (t.planId || '') === (what.planId || '') && (t.invoiceId || '') === (what.invoiceId || '')
      && (t.placementId || '') === (what.placementId || '') && t.amountPaise === what.q.totalPaise && Date.now() - Date.parse(t.createdAt) < 30 * 60000);
    let txn = recent;
    if (!txn) {
      const id = crypto.randomUUID();
      let order;
      try {
        order = await gateway.createOrder({ amountPaise: what.q.totalPaise, currency: what.q.currency, receipt: id, notes: { transaction: id, company: emp.id } });
      } catch (e) {
        console.error('Payment order:', e.message);
        return { status: 502, error: 'the payment service did not answer; please try again in a minute' };
      }
      if (order.amountPaise !== what.q.totalPaise || order.currency !== what.q.currency) return { status: 502, error: 'the payment service returned a different amount; nothing was charged' };
      txn = add(TXNS, {
        id, employerId: emp.id, purpose: what.purpose, planId: what.planId || null, invoiceId: what.invoiceId || null, placementId: what.placementId || null, invoiceKey: what.invoiceKey || null,
        provider: gateway.name, orderId: order.id, paymentId: null, amountPaise: what.q.totalPaise, currency: what.q.currency, status: 'created', quote: what.q, label: what.label,
        createdBy: { userId: req.employerUser.id, name: req.employerUser.name }, refundedPaise: 0, attempts: [],
      });
      clients.team.audit(emp.id, req.employerUser, 'payment-started', `${what.label}: ${inr(txn.amountPaise)}`);
    }
    return {
      status: 200,
      body: {
        ok: true, transactionId: txn.id, provider: gateway.name, key: gateway.publicKey, orderId: txn.orderId, amountPaise: txn.amountPaise, currency: txn.currency,
        name: site.name, description: txn.label, sandbox: Boolean(gateway.sandbox), quote: { lines: txn.quote.lines, subtotalPaise: txn.quote.subtotalPaise, taxLines: txn.quote.taxLines, totalPaise: txn.quote.totalPaise },
        prefill: { name: req.employerUser.name, email: req.employerUser.email },
      },
    };
  }

  // ---------- settling a payment (checkout, webhook or reconciliation) ----------
  // Runs in one database transaction: whichever path arrives first settles the
  // payment; every later one finds it settled and changes nothing.
  function settle(txnId, payment, via) {
    const out = db.transaction(() => {
      const txn = find(TXNS, 'id', txnId);
      if (!txn) return { error: 'unknown transaction' };
      if (SETTLED.includes(txn.status)) return { txn, already: true };
      txn.attempts = [{ at: iso(), via, paymentId: payment.id, status: payment.status }, ...(txn.attempts || [])].slice(0, 20);
      if (payment.orderId !== txn.orderId || payment.amountPaise !== txn.amountPaise || payment.currency !== txn.currency) {
        txn.status = 'review';
        txn.problem = `payment ${payment.id} does not match the order (amount ${payment.amountPaise} ${payment.currency}, order ${payment.orderId})`;
        put(TXNS, txn);
        return { txn, mismatch: true };
      }
      if (payment.status === 'failed') {
        txn.status = 'failed';
        txn.failure = payment.error || 'Payment failed';
        txn.failedAt = iso();
        put(TXNS, txn);
        return { txn, failed: true };
      }
      if (payment.status !== 'paid') {
        txn.status = 'pending';
        txn.paymentId = payment.id;
        put(TXNS, txn);
        return { txn, pending: true };
      }
      Object.assign(txn, { status: 'paid', paymentId: payment.id, method: payment.method, paidAt: iso(), verifiedBy: via, failure: null });
      const result = fulfil(txn);
      txn.resultInvoiceId = result.invoice ? result.invoice.id : txn.invoiceId || null;
      put(TXNS, txn);
      return { txn, fresh: true, ...result };
    });
    if (out.fresh) afterPaid(out);
    if (out.failed) {
      const emp = employerById(out.txn.employerId);
      if (emp) tellCompany(emp, `billing:${out.txn.id}:failed:${payment.id}`, { title: 'Payment failed', body: `${out.txn.label}: ${out.txn.failure}. Nothing was charged; you can try again.`, subject: `Payment failed: ${out.txn.label}`, intro: `your payment for ${out.txn.label} did not go through (${out.txn.failure}). Your plan has not changed. You can try again from Billing.` });
    }
    if (out.mismatch) tellFinance(`billing:${out.txn.id}:review`, 'Payment needs checking', `A payment did not match its order (${out.txn.label}). It was not counted.`);
    return out;
  }

  // What a paid transaction buys. Called inside settle's transaction.
  function fulfil(txn) {
    const emp = employerById(txn.employerId);
    const today = todayIst();
    const payment = { id: crypto.randomUUID(), transactionId: txn.id, date: today, amountPaise: txn.amountPaise, mode: `Online (${gateway.label || txn.provider})`, reference: txn.paymentId };
    if (txn.purpose === 'invoice') {
      const inv = find(INVOICES, 'id', txn.invoiceId);
      inv.payments = [...(inv.payments || []), payment];
      store.refreshInvoice(inv);
      put(INVOICES, inv);
      return { invoice: null, paidInvoice: inv };
    }
    if (txn.purpose === 'placement-invoice') {
      placements.onlinePayment(txn.placementId, txn.invoiceKey, { amountPaise: txn.amountPaise, reference: txn.paymentId, transactionId: txn.id, date: today });
      return {};
    }
    const plan = store.planById(txn.planId);
    const invoice = store.issueInvoice(emp, { kind: txn.purpose === 'package' ? 'package' : 'subscription', q: txn.quote, transactionId: txn.id, payment });
    if (txn.purpose === 'package') return { invoice };
    const sub = store.subOf(emp.id);
    const period = txn.quote.period;
    store.changeSub(emp, sub, {
      planId: plan.id, plan: store.snapshot(plan), status: 'active', periodStart: period.from, periodEnd: addDays(period.to, 1),
      cancelAtPeriodEnd: false, cancelledAt: null, nextPlanId: null, graceEnds: null, reminders: [], startedAt: (sub && sub.startedAt) || iso(),
    }, txn.purpose === 'renewal' ? 'renewed' : sub && sub.plan && sub.plan.pricePaise > 0 ? 'upgraded' : 'started', `payment ${txn.paymentId}`);
    return { invoice, plan };
  }
  function afterPaid({ txn, invoice }) {
    const emp = employerById(txn.employerId);
    if (!emp) return;
    clients.team.audit(emp.id, null, 'payment-received', `${txn.label}: ${inr(txn.amountPaise)} (${txn.paymentId})${invoice ? ` · invoice ${invoice.number}` : ''}`);
    tellCompany(emp, `billing:${txn.id}:paid`, {
      title: 'Payment received', body: `${txn.label}: ${inr(txn.amountPaise)}${invoice ? ` · invoice ${invoice.number}` : ''}`,
      subject: `Payment received: ${txn.label}`, intro: `thank you, we received ${inr(txn.amountPaise)} for ${txn.label}.`,
      rows: [['Payment reference', txn.paymentId], ...(invoice ? [['Invoice', invoice.number]] : [])],
    });
    if (txn.purpose === 'package') tellFinance(`billing:${txn.id}:package`, 'Service package bought', `${emp.company} bought ${txn.label}. Arrange the service with them.`);
  }

  // The browser's report after checkout: the signature must match AND the
  // provider must confirm the payment before anything changes.
  async function verifyCheckout(req, body) {
    const orderId = clip(body.orderId || body.razorpay_order_id, 80);
    const paymentId = clip(body.paymentId || body.razorpay_payment_id, 80);
    const signature = clip(body.signature || body.razorpay_signature, 200);
    const txn = orderId ? find(TXNS, 'orderId', orderId) : null;
    // Only this company's own orders, never by guessing one.
    if (!txn || txn.employerId !== req.employer.id || txn.provider !== gateway.name) return { status: 404, error: 'payment not found' };
    if (SETTLED.includes(txn.status)) return { status: 200, body: { ok: true, status: txn.status, already: true, transaction: txnJson(txn) } };
    if (!gateway.verifyCheckout({ orderId, paymentId, signature })) {
      txn.lastError = 'checkout signature did not match';
      put(TXNS, txn);
      return { status: 400, error: 'we could not verify this payment; nothing has changed' };
    }
    let payment;
    try {
      payment = await gateway.fetchPayment(paymentId);
    } catch (e) {
      console.error('Payment check:', e.message);
      return { status: 202, body: { ok: true, status: 'pending', message: 'We are confirming your payment with the bank; this page will update once it is confirmed.' } };
    }
    if (payment.orderId !== orderId) return { status: 400, error: 'that payment belongs to another order' };
    const r = settle(txn.id, payment, 'checkout');
    const t = r.txn || txn;
    return { status: r.mismatch ? 409 : 200, body: { ok: !r.mismatch && !r.failed, status: t.status, transaction: txnJson(t), invoiceId: t.resultInvoiceId || null } };
  }

  // ---------- webhooks ----------
  async function handleEvent(ev) {
    if (ev.kind === 'payment' && ev.payment) {
      const txn = ev.payment.orderId ? find(TXNS, 'orderId', ev.payment.orderId) : null;
      if (!txn || txn.provider !== gateway.name) return { status: 'ignored', result: 'no matching order' };
      const r = settle(txn.id, ev.payment, 'webhook');
      return { status: 'processed', result: r.already ? 'already settled' : r.fresh ? 'paid' : r.failed ? 'failed' : r.pending ? 'pending' : r.mismatch ? 'mismatch' : 'no change' };
    }
    if (ev.kind === 'refund' && ev.refund) {
      const r = ev.refund;
      const txn = find(TXNS, 'paymentId', r.paymentId);
      return db.transaction(() => {
        const rec = find(REFUNDS, 'providerRefundId', r.id);
        if (rec) {
          if (rec.status !== r.status && rec.status !== 'processed') put(REFUNDS, Object.assign(rec, { status: r.status, processedAt: r.status === 'processed' ? iso() : rec.processedAt }));
          return { status: 'processed', result: `refund ${r.status}` };
        }
        if (!txn) return { status: 'ignored', result: 'no matching payment' };
        // Made outside Hireriv (e.g. in the provider's dashboard): recorded for
        // reconciliation, without a credit note until finance issues one.
        add(REFUNDS, { provider: gateway.name, providerRefundId: r.id, transactionId: txn.id, employerId: txn.employerId, amountPaise: r.amountPaise, reason: 'Made at the payment provider', status: r.status, external: true, requestedBy: null, approvedBy: null });
        return { status: 'processed', result: 'refund made outside Hireriv: recorded for review' };
      });
    }
    if (ev.kind === 'dispute' && ev.dispute) {
      const d = ev.dispute;
      const txn = find(TXNS, 'paymentId', d.paymentId);
      if (!txn) return { status: 'ignored', result: 'no matching payment' };
      txn.dispute = { id: d.id, status: d.status, amountPaise: d.amountPaise, reason: d.reason, updatedAt: iso() };
      put(TXNS, txn);
      tellFinance(`billing:dispute:${d.id}:${d.status}`, `Payment dispute ${d.status}`, `${txn.label}: ${inr(d.amountPaise)} (${d.reason || 'no reason given'}). Respond in the provider's dashboard before the deadline.`);
      return { status: 'processed', result: `dispute ${d.status}` };
    }
    return { status: 'ignored', result: `not used: ${ev.type}` };
  }

  // Signature first (on the exact bytes), then once per event id.
  app.post('/api/webhooks/payments/:provider', limit('payment-webhooks', 600), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.params.provider !== gateway.name || !gateway.webhooks) return res.status(404).json({ ok: false });
    if (!gateway.verifyWebhook(req.rawBody, req.headers)) return res.status(400).json({ ok: false, error: 'invalid signature' });
    const ev = gateway.parseWebhook(req.body, req.headers);
    const ids = { orderId: (ev.payment && ev.payment.orderId) || null, paymentId: (ev.payment && ev.payment.id) || (ev.refund && ev.refund.paymentId) || (ev.dispute && ev.dispute.paymentId) || null, refundId: (ev.refund && ev.refund.id) || null };
    let rec = db.where(EVENTS, 'eventId', ev.eventId).find((e) => e.provider === gateway.name);
    if (rec && rec.status !== 'error') return res.json({ ok: true, duplicate: true });
    if (!rec) {
      try {
        rec = add(EVENTS, { provider: gateway.name, eventId: ev.eventId, type: ev.type, status: 'received', ...ids, amountPaise: (ev.payment || ev.refund || ev.dispute || {}).amountPaise || null, receivedAt: iso(), tries: 0 });
      } catch (e) {
        if (e.code === 'ERR_UNIQUE') return res.json({ ok: true, duplicate: true });
        throw e;
      }
    }
    rec.tries = (rec.tries || 0) + 1;
    try {
      const r = await handleEvent(ev);
      put(EVENTS, Object.assign(rec, r, { processedAt: iso() }));
      res.json({ ok: true });
    } catch (e) {
      console.error('Payment webhook:', e.message);
      // The provider retries; the retry is processed again.
      put(EVENTS, Object.assign(rec, { status: 'error', result: clip(e.message, 200) }));
      res.status(500).json({ ok: false });
    }
  });

  // ---------- plan changes and cancellation ----------
  function changePlan(req, planId) {
    const emp = req.employer;
    const plan = store.planById(clip(planId, 60));
    if (!plan || !plan.active || plan.kind !== 'subscription') return { status: 404, error: 'plan not found' };
    if (plan.custom) return { status: 409, error: 'this plan is quoted for each company: ask us for a quote' };
    const { sub, plan: cur, managed } = store.currentPlan(emp);
    if (managed && !sub) return { status: 409, error: 'your account is billed by your Hireriv account manager; ask them to change your plan' };
    if (cur && cur.id === plan.id) {
      if (sub && sub.nextPlanId) { store.changeSub(emp, sub, { nextPlanId: null }, 'change-undone', req.employerUser.name); return { status: 200, msg: `You stay on ${plan.name}` }; }
      return { status: 409, error: `you are already on ${plan.name}` };
    }
    const paidNow = sub && sub.periodEnd && sub.plan && sub.plan.pricePaise > 0 && sub.status === 'active';
    if (plan.pricePaise > 0 && (!paidNow || perMonth(plan) > perMonth(sub.plan))) return { status: 409, error: `${plan.name} starts once it is paid: choose Upgrade`, checkout: true };
    if (paidNow) {
      store.changeSub(emp, sub, { nextPlanId: plan.id, cancelAtPeriodEnd: false }, 'downgrade-scheduled', req.employerUser.name);
      clients.team.audit(emp.id, req.employerUser, 'plan-change-scheduled', `${sub.plan.name} → ${plan.name} on ${sub.periodEnd}`);
      return { status: 200, msg: `${plan.name} starts on ${formatYmd(sub.periodEnd)}, when your paid period ends` };
    }
    store.changeSub(emp, sub, { planId: plan.id, plan: store.snapshot(plan), status: 'active', periodStart: todayIst(), periodEnd: null, cancelAtPeriodEnd: false, nextPlanId: null, graceEnds: null }, 'changed', req.employerUser.name);
    clients.team.audit(emp.id, req.employerUser, 'plan-changed', `now on ${plan.name}`);
    return { status: 200, msg: `You are now on ${plan.name}` };
  }
  function cancelPlan(req, reason) {
    const emp = req.employer;
    const sub = store.subOf(emp.id);
    if (!sub || !sub.periodEnd || !(sub.plan && sub.plan.pricePaise > 0) || !['active', 'past_due'].includes(sub.status)) return { status: 409, error: 'there is no paid plan to cancel' };
    if (sub.cancelAtPeriodEnd) return { status: 200, msg: `Already cancelled: ${sub.plan.name} ends on ${formatYmd(sub.periodEnd)}` };
    // Overdue and unpaid: back to the free plan now. Otherwise it runs to the end of the paid period.
    if (sub.status === 'past_due') {
      store.toFree(emp, sub, 'cancelled', req.employerUser.name);
      clients.team.audit(emp.id, req.employerUser, 'plan-cancelled', `${sub.plan.name}, unpaid renewal: moved to the free plan${reason ? ` · ${reason}` : ''}`);
      return { status: 200, msg: 'Cancelled. You are on the free plan now.' };
    }
    store.changeSub(emp, sub, { cancelAtPeriodEnd: true, cancelledAt: iso(), cancelReason: clip(reason, 300), nextPlanId: null }, 'cancel-requested', req.employerUser.name);
    clients.team.audit(emp.id, req.employerUser, 'plan-cancelled', `${sub.plan.name} ends on ${sub.periodEnd}${reason ? ` · ${clip(reason, 200)}` : ''}`);
    tellCompany(emp, `billing:${sub.id}:cancel:${sub.periodEnd}`, { title: 'Plan cancelled', body: `${sub.plan.name} stays until ${formatYmd(sub.periodEnd)}, then moves to the free plan.`, subject: `Your ${sub.plan.name} plan is cancelled`, intro: `${req.employerUser.name} cancelled the ${sub.plan.name} plan. It stays active until ${formatYmd(sub.periodEnd)}, then your company moves to the free plan. You can undo this until then.` });
    return { status: 200, msg: `Cancelled. ${sub.plan.name} stays until ${formatYmd(sub.periodEnd)}.` };
  }
  function resumePlan(req) {
    const sub = store.subOf(req.employer.id);
    if (!sub || !sub.cancelAtPeriodEnd || sub.status !== 'active') return { status: 409, error: 'there is no cancellation to undo' };
    store.changeSub(req.employer, sub, { cancelAtPeriodEnd: false, cancelledAt: null, cancelReason: '' }, 'cancel-undone', req.employerUser.name);
    clients.team.audit(req.employer.id, req.employerUser, 'plan-resumed', sub.plan.name);
    return { status: 200, msg: `${sub.plan.name} will renew on ${formatYmd(sub.periodEnd)}` };
  }

  // ---------- refunds (asked for by one person, approved by another) ----------
  const refundable = (txn) => txn.amountPaise - (txn.refundedPaise || 0) - db.where(REFUNDS, 'transactionId', txn.id).filter((r) => ['requested', 'sending'].includes(r.status)).reduce((n, r) => n + r.amountPaise, 0);
  function requestRefund(user, body) {
    const txn = find(TXNS, 'id', clip(body.transactionId, 60));
    if (!txn) return { status: 404, error: 'payment not found' };
    if (!['paid', 'partially_refunded'].includes(txn.status)) return { status: 409, error: 'only paid payments can be refunded' };
    if (txn.purpose === 'placement-invoice') return { status: 409, error: 'refund placement invoices from the placement: issue the credit note there, then refund' };
    const amountPaise = body.amountPaise != null && body.amountPaise !== '' ? Number(body.amountPaise) : S.paiseIn(body.amount);
    const reason = clip(body.reason, 60);
    const note = clip(body.note, 500);
    const errors = [];
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) errors.push('enter the amount to refund');
    else if (amountPaise > refundable(txn)) errors.push(`at most ${inr(refundable(txn))} can be refunded on this payment`);
    if (!S.REFUND_REASONS.includes(reason)) errors.push('choose a reason');
    if (reason === 'Other' && !note) errors.push('explain the refund');
    if (errors.length) return { status: 400, errors };
    const emp = employerById(txn.employerId);
    const rec = add(REFUNDS, {
      provider: txn.provider, providerRefundId: null, transactionId: txn.id, employerId: txn.employerId, amountPaise, reason, note,
      endPlan: ['1', 'on', 'true', true].includes(body.endPlan) && ['plan', 'renewal'].includes(txn.purpose), status: 'requested',
      requestedBy: { id: user.id, name: user.name }, approvedBy: null,
    });
    trust.record(user, 'billing-refund-requested', { entityType: 'payment', entityId: txn.id, reason: `${reason}${note ? `: ${note}` : ''}`, detail: `${inr(amountPaise)} of ${inr(txn.amountPaise)} · ${emp ? emp.company : txn.employerId}` });
    team.log(user, `Asked for a refund of ${inr(amountPaise)} (${txn.label})`, rec.id);
    tellFinance(`billing:refund:${rec.id}`, 'Refund to approve', `${user.name} asked to refund ${inr(amountPaise)} to ${emp ? emp.company : 'a company'} (${txn.label}). Someone else must approve it.`, '/admin/billing?view=refunds');
    return { status: 201, refund: rec };
  }
  // The credit note for a refund: the same share of tax as the invoice.
  function creditNoteFor(inv, amountPaise, reason, refundId) {
    const subtotalPaise = Math.round((amountPaise * inv.subtotalPaise) / inv.totalPaise);
    const { taxLines } = S.taxOf(subtotalPaise, inv.gstPercent, inv.taxType);
    // Rounding stays inside the refunded amount.
    const tax = amountPaise - subtotalPaise;
    if (taxLines.length === 2) { taxLines[0].amountPaise = Math.round(tax / 2); taxLines[1].amountPaise = tax - taxLines[0].amountPaise; } else if (taxLines.length === 1) taxLines[0].amountPaise = tax;
    const date = todayIst();
    return { id: crypto.randomUUID(), number: store.nextNumber('CN', date), date, reason, subtotalPaise, taxLines, taxPaise: tax, totalPaise: amountPaise, refundId };
  }
  async function decideRefund(user, id, decision, note) {
    const pending = db.transaction(() => {
      const rec = find(REFUNDS, 'id', clip(id, 60));
      if (!rec) return { status: 404, error: 'refund not found' };
      if (rec.status !== 'requested') return { status: 409, error: `this refund is already ${rec.status}` };
      if (rec.requestedBy && rec.requestedBy.id === user.id) return { status: 403, error: 'someone other than the person who asked must approve or reject a refund' };
      const txn = find(TXNS, 'id', rec.transactionId);
      if (decision === 'reject') {
        put(REFUNDS, Object.assign(rec, { status: 'rejected', approvedBy: { id: user.id, name: user.name }, decidedAt: iso(), decisionNote: clip(note, 300) }));
        trust.record(user, 'billing-refund-rejected', { entityType: 'payment', entityId: rec.transactionId, reason: clip(note, 300) || 'rejected', detail: inr(rec.amountPaise) });
        return { status: 200, rec, done: true };
      }
      if (!['paid', 'partially_refunded'].includes(txn.status) || rec.amountPaise > txn.amountPaise - (txn.refundedPaise || 0)) return { status: 409, error: 'the payment can no longer be refunded by this amount' };
      put(REFUNDS, Object.assign(rec, { status: 'sending', approvedBy: { id: user.id, name: user.name }, decidedAt: iso() }));
      return { rec, txn };
    });
    if (pending.error || pending.done) return pending;
    const { rec, txn } = pending;
    let sent;
    try {
      sent = await gateway.refund(txn.paymentId, { amountPaise: rec.amountPaise, notes: { refund: rec.id } });
    } catch (e) {
      put(REFUNDS, Object.assign(rec, { status: 'failed', error: clip(e.message, 200) }));
      trust.record(user, 'billing-refund-failed', { entityType: 'payment', entityId: txn.id, reason: rec.reason, detail: clip(e.message, 200) });
      return { status: 502, error: 'the payment service refused the refund; nothing was refunded', refund: rec };
    }
    const result = db.transaction(() => {
      const t = find(TXNS, 'id', txn.id);
      t.refundedPaise = (t.refundedPaise || 0) + rec.amountPaise;
      t.status = t.refundedPaise >= t.amountPaise ? 'refunded' : 'partially_refunded';
      put(TXNS, t);
      const inv = find(INVOICES, 'id', t.resultInvoiceId || t.invoiceId);
      let cn = null;
      if (inv) {
        cn = creditNoteFor(inv, rec.amountPaise, rec.reason, rec.id);
        inv.creditNotes = [...(inv.creditNotes || []), cn];
        inv.refunds = [...(inv.refunds || []), { refundId: rec.id, amountPaise: rec.amountPaise, date: todayIst() }];
        store.refreshInvoice(inv);
        put(INVOICES, inv);
      }
      put(REFUNDS, Object.assign(rec, { status: sent.status, providerRefundId: sent.id, creditNoteId: cn ? cn.id : null, creditNoteNumber: cn ? cn.number : null, processedAt: sent.status === 'processed' ? iso() : null }));
      const emp = employerById(t.employerId);
      if (rec.endPlan && emp) {
        const sub = store.subOf(emp.id);
        if (sub && sub.planId === t.planId) store.toFree(emp, sub, 'refunded', user.name);
      }
      return { t, cn, emp };
    });
    trust.record(user, 'billing-refund-approved', { entityType: 'payment', entityId: txn.id, reason: rec.reason, detail: `${inr(rec.amountPaise)} · provider refund ${sent.id}${result.cn ? ` · credit note ${result.cn.number}` : ''}${rec.endPlan ? ' · plan ended' : ''}` });
    team.log(user, `Approved a refund of ${inr(rec.amountPaise)} (${txn.label})`, rec.id);
    if (result.emp) {
      clients.team.audit(result.emp.id, null, 'refund-issued', `${inr(rec.amountPaise)} for ${txn.label}${result.cn ? ` · credit note ${result.cn.number}` : ''}`);
      tellCompany(result.emp, `billing:refund:${rec.id}:sent`, { title: 'Refund on its way', body: `${inr(rec.amountPaise)} for ${txn.label}`, subject: `Refund of ${inr(rec.amountPaise)}`, intro: `we have refunded ${inr(rec.amountPaise)} for ${txn.label}. Banks usually take 5–7 working days to show it.`, rows: result.cn ? [['Credit note', result.cn.number]] : [] });
    }
    return { status: 200, refund: find(REFUNDS, 'id', rec.id) };
  }

  // ---------- daily: renewals, reminders, grace periods and stale orders ----------
  function remind(emp, sub, key, title, intro) {
    if ((sub.reminders || []).includes(key)) return false;
    sub.reminders = [...(sub.reminders || []), key].slice(-30);
    put(SUBS, sub);
    tellCompany(emp, `billing:${sub.id}:${key}`, { title, body: intro, subject: `${title}: ${site.name} ${sub.plan ? sub.plan.name : ''} plan`.trim(), intro });
    return true;
  }
  function renewals() {
    const today = todayIst();
    const s = store.settings();
    const out = { reminded: 0, pastDue: 0, expired: 0, switched: 0 };
    for (const sub of db.all(SUBS)) {
      const emp = employerById(sub.employerId);
      if (!emp || !sub.periodEnd) continue;
      const left = daysBetween(today, sub.periodEnd);
      if (sub.status === 'active' && left <= 0) {
        const next = sub.nextPlanId ? store.planById(sub.nextPlanId) : null;
        if (sub.cancelAtPeriodEnd || (next && !(next.pricePaise > 0))) {
          if (next && !sub.cancelAtPeriodEnd) store.changeSub(emp, sub, { planId: next.id, plan: store.snapshot(next), periodStart: today, periodEnd: null, nextPlanId: null, reminders: [] }, 'downgraded', 'renewal');
          else store.toFree(emp, sub, 'ended', 'renewal');
          clients.team.audit(emp.id, null, 'plan-ended', `${sub.plan ? sub.plan.name : 'plan'} ended; now on ${next && !sub.cancelAtPeriodEnd ? next.name : 'the free plan'}`);
          out.switched++;
          continue;
        }
        store.changeSub(emp, sub, { status: 'past_due', graceEnds: addDays(sub.periodEnd, s.graceDays) }, 'payment-due', 'renewal');
        remind(emp, find(SUBS, 'id', sub.id), `due:${sub.periodEnd}`, 'Renewal payment due', `your plan was due to renew on ${formatYmd(sub.periodEnd)}. Pay by ${formatYmd(addDays(sub.periodEnd, s.graceDays))} to keep it; after that your company moves to the free plan.`);
        out.pastDue++;
      } else if (sub.status === 'active' && !sub.cancelAtPeriodEnd && s.reminderDays.includes(left) && sub.plan && sub.plan.pricePaise > 0) {
        if (remind(emp, sub, `before:${sub.periodEnd}:${left}`, 'Plan renews soon', `your ${sub.plan.name} plan renews on ${formatYmd(sub.periodEnd)} (in ${left} day${left === 1 ? '' : 's'}). Pay the renewal from Billing to keep it without a break.`)) out.reminded++;
      } else if (sub.status === 'past_due' && sub.graceEnds) {
        if (today >= sub.graceEnds) {
          store.toFree(emp, sub, 'expired-unpaid', 'renewal');
          clients.team.audit(emp.id, null, 'plan-ended', `${sub.plan ? sub.plan.name : 'plan'} not renewed; now on the free plan`);
          tellCompany(emp, `billing:${sub.id}:expired:${sub.periodEnd}`, { title: 'Plan ended', body: 'The renewal was not paid, so your company is on the free plan now.', subject: 'Your plan has ended', intro: 'the renewal was not paid within the grace period, so your company is on the free plan now. Live jobs stay up; new ones need room under the free plan. You can upgrade again any time.' });
          out.expired++;
        } else if (daysBetween(today, sub.graceEnds) === 1) {
          if (remind(emp, sub, `last:${sub.periodEnd}`, 'Last day to renew', `pay the renewal today to keep your ${sub.plan ? sub.plan.name : ''} plan.`)) out.reminded++;
        }
      }
    }
    return out;
  }
  // Orders the browser never confirmed: ask the provider (a missed webhook
  // can't leave a paid order unpaid), and close old ones that were never paid.
  async function reconcileOrders({ olderThanMs = 10 * 60000 } = {}) {
    const out = { checked: 0, settled: 0, expired: 0 };
    if (!gateway.ready) return out;
    const now = Date.now();
    for (const t of db.all(TXNS).filter((x) => ['created', 'pending', 'failed'].includes(x.status) && x.provider === gateway.name)) {
      const age = now - Date.parse(t.createdAt);
      if (age < olderThanMs) continue;
      if (age > 3 * 86400000 && t.status !== 'pending') { put(TXNS, Object.assign(t, { status: 'expired' })); out.expired++; continue; }
      try {
        out.checked++;
        const list = await gateway.orderPayments(t.orderId);
        const best = list.find((p) => p.status === 'paid') || list.find((p) => p.status === 'pending');
        if (best) { const r = settle(t.id, best, 'reconciliation'); if (r.fresh) out.settled++; }
      } catch (e) { console.error('Payment reconciliation:', e.message); }
    }
    return out;
  }
  const daily = async () => ({ ...renewals(), ...(await reconcileOrders()) });

  // ---------- reconciliation report ----------
  function reconciliation() {
    const txns = db.all(TXNS);
    const invoices = db.all(INVOICES);
    const refunds = db.all(REFUNDS);
    const issues = [];
    const byId = new Map(invoices.map((i) => [i.id, i]));
    for (const t of txns) {
      if (SETTLED.includes(t.status) && !['placement-invoice', 'invoice'].includes(t.purpose)) {
        const inv = byId.get(t.resultInvoiceId);
        if (!inv) issues.push({ kind: 'Paid without an invoice', ref: t.id, detail: `${t.label} · ${inr(t.amountPaise)}` });
        else if (inv.totalPaise !== t.amountPaise) issues.push({ kind: 'Invoice total differs from payment', ref: inv.number, detail: `${inr(inv.totalPaise)} vs ${inr(t.amountPaise)}` });
      }
      if (t.status === 'review') issues.push({ kind: 'Payment did not match its order', ref: t.id, detail: t.problem || '' });
      const processed = refunds.filter((r) => r.transactionId === t.id && !r.external && ['processing', 'processed'].includes(r.status)).reduce((n, r) => n + r.amountPaise, 0);
      if (processed !== (t.refundedPaise || 0)) issues.push({ kind: 'Refunds differ from the payment record', ref: t.id, detail: `${inr(processed)} vs ${inr(t.refundedPaise || 0)}` });
      if (t.dispute && !['won', 'closed'].includes(t.dispute.status)) issues.push({ kind: `Dispute ${t.dispute.status}`, ref: t.id, detail: `${t.label} · ${inr(t.dispute.amountPaise)}` });
      if (t.status === 'pending' && Date.now() - Date.parse(t.createdAt) > 86400000) issues.push({ kind: 'Pending for more than a day', ref: t.id, detail: t.label });
    }
    for (const inv of invoices.filter((i) => i.transactionId)) {
      const t = txns.find((x) => x.id === inv.transactionId);
      if (!t || !SETTLED.includes(t.status)) issues.push({ kind: 'Invoice without a settled payment', ref: inv.number, detail: t ? t.status : 'no payment' });
    }
    for (const r of refunds) {
      if (r.external) issues.push({ kind: 'Refund made at the provider, no credit note', ref: r.providerRefundId, detail: inr(r.amountPaise) });
      if (r.status === 'sending') issues.push({ kind: 'Refund stuck while sending', ref: r.id, detail: inr(r.amountPaise) });
      if (r.status === 'failed') issues.push({ kind: 'Refund failed', ref: r.id, detail: r.error || '' });
    }
    for (const e of db.all(EVENTS).filter((x) => x.status === 'error')) issues.push({ kind: 'Webhook failed', ref: e.eventId, detail: `${e.type}: ${e.result || ''}` });
    const sum = (list, f) => list.reduce((n, x) => n + f(x), 0);
    const paid = txns.filter((t) => SETTLED.includes(t.status));
    const months = {};
    for (const t of paid) {
      const m = (t.paidAt || t.createdAt).slice(0, 7);
      months[m] = months[m] || { month: m, collectedPaise: 0, refundedPaise: 0, count: 0 };
      months[m].collectedPaise += t.amountPaise;
      months[m].refundedPaise += t.refundedPaise || 0;
      months[m].count++;
    }
    const subInvoices = invoices.filter((i) => i.status !== 'Cancelled');
    return {
      issues,
      totals: {
        collectedPaise: sum(paid, (t) => t.amountPaise), refundedPaise: sum(paid, (t) => t.refundedPaise || 0),
        invoicedPaise: sum(subInvoices, (i) => i.totalPaise), gstPaise: sum(subInvoices, (i) => i.taxPaise), creditedPaise: sum(subInvoices, (i) => store.creditedOf(i)),
        outstandingPaise: sum(subInvoices, (i) => store.balanceOf(i)),
      },
      months: Object.values(months).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12),
    };
  }
  // Recurring revenue from active paid plans (yearly plans as a twelfth a month).
  function mrr() {
    return db.all(SUBS).filter((s) => ['active', 'past_due'].includes(s.status) && s.plan && s.plan.pricePaise > 0 && !s.cancelAtPeriodEnd).reduce((n, s) => n + Math.round(perMonth(s.plan)), 0);
  }

  // ---------- employer pages and API ----------
  const need = (action) => (req, res, next) => (S.employerCan(req.member, action) ? next() : clients.forbid(req, res));
  const send = (res, r, ok = (x) => x) => (r.error || r.errors ? res.status(r.status || 400).json({ ok: false, errors: r.errors || [r.error], ...(r.checkout ? { checkout: true } : {}) }) : res.status(r.status || 200).json(r.body || { ok: true, ...ok(r) }));
  const apiLimit = limit('billing-api', 300);

  // Plans are public: anyone can see the prices.
  app.get('/api/billing/plans', apiLimit, (req, res) => res.json({ ok: true, currency: S.CURRENCY, plans: store.plans().filter((p) => p.active).map(store.publicPlan) }));
  app.get('/api/billing/subscription', requireEmployerApi, need('billing.view'), apiLimit, (req, res) => res.json({ ok: true, subscription: subscriptionJson(req.employer) }));
  app.post('/api/billing/checkout', requireEmployerApi, need('billing.manage'), limit('billing-checkout', 20), sameOrigin, async (req, res) => send(res, await checkout(req, req.body)));
  app.post('/api/billing/checkout/verify', requireEmployerApi, need('billing.manage'), limit('billing-verify', 60), sameOrigin, async (req, res) => send(res, await verifyCheckout(req, req.body || {})));
  app.post('/api/billing/subscription/change', requireEmployerApi, need('billing.manage'), limit('billing-change', 20), sameOrigin, (req, res) => send(res, changePlan(req, (req.body || {}).planId), () => ({ subscription: subscriptionJson(req.employer) })));
  app.post('/api/billing/subscription/cancel', requireEmployerApi, need('billing.manage'), limit('billing-change', 20), sameOrigin, (req, res) => send(res, cancelPlan(req, (req.body || {}).reason), () => ({ subscription: subscriptionJson(req.employer) })));
  app.post('/api/billing/subscription/resume', requireEmployerApi, need('billing.manage'), limit('billing-change', 20), sameOrigin, (req, res) => send(res, resumePlan(req), () => ({ subscription: subscriptionJson(req.employer) })));
  app.get('/api/billing/invoices', requireEmployerApi, need('billing.view'), apiLimit, (req, res) => {
    const staffing = placements.forClient(req.employer).flatMap((p) => p.invoices.map((i) => ({
      id: `${p.id}${i.key === 'main' ? '' : `:${i.key}`}`, kind: 'placement', number: i.number, date: i.date, dueDate: i.dueDate, status: i.status, overdue: i.overdue, currency: S.CURRENCY,
      totalPaise: Math.round(i.total * 100), balancePaise: Math.round(Math.max(0, i.balance) * 100), for: `${p.candidateName} · ${p.jobTitle}${i.month ? ` · ${i.month}` : ''}`,
      url: `/employer/invoices/${p.id}${i.key === 'main' ? '' : `?inv=${i.key}`}`, pay: { placementId: p.id, invoice: i.key },
    })));
    res.json({ ok: true, invoices: store.invoicesOf(req.employer.id).map(invoiceJson), staffing });
  });
  app.get('/api/billing/invoices/:id', requireEmployerApi, need('billing.view'), apiLimit, (req, res) => {
    const inv = find(INVOICES, 'id', req.params.id);
    // Another company's invoice is "not found", the same as one that doesn't exist.
    if (!inv || inv.employerId !== req.employer.id) return res.status(404).json({ ok: false, errors: ['invoice not found'] });
    res.json({ ok: true, invoice: invoiceJson(inv) });
  });
  app.get('/api/billing/payments', requireEmployerApi, need('billing.view'), apiLimit, (req, res) => res.json({ ok: true, payments: db.where(TXNS, 'employerId', req.employer.id).filter((t) => t.status !== 'created').map(txnJson) }));
  app.get('/api/billing/profile', requireEmployerApi, need('billing.view'), apiLimit, (req, res) => res.json({ ok: true, profile: store.profileOf(req.employer) }));
  app.put('/api/billing/profile', requireEmployerApi, need('billing.manage'), limit('billing-profile', 20), sameOrigin, (req, res) => {
    const { errors, profile } = store.parseProfile(req.employer, req.body || {});
    if (errors.length) return res.status(400).json({ ok: false, errors });
    saveProfile(req, profile);
    res.json({ ok: true, profile: store.profileOf(req.employer) });
  });
  function saveProfile(req, profile) {
    const old = store.find(store.PROFILES, 'employerId', req.employer.id);
    store.put(store.PROFILES, { ...(old || { id: crypto.randomUUID(), createdAt: iso() }), ...profile });
    clients.team.audit(req.employer.id, req.employerUser, 'billing-details-changed', [profile.legalName, profile.gstin, profile.stateName].filter(Boolean).join(' · '));
  }

  const billingPage = (req, res, extra = {}, status = 200) => {
    const emp = req.employer;
    res.set('Cache-Control', 'no-store');
    // The payment window comes from the provider's own script on this page only.
    if (gateway.ready) {
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://checkout.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com; img-src 'self' data: https://cdn.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
      res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://api.razorpay.com" "https://checkout.razorpay.com")');
      res.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    }
    const sub = subscriptionJson(emp);
    const all = store.plans().filter((p) => p.active);
    res.status(status).render('employer-billing', {
      title: `${emp.company} · Billing`, page: 'employer', noindex: true, tab: 'billing', errors: [], msg: clip(req.query.msg, 300), ...extra,
      sub, plans: all.filter((p) => p.kind === 'subscription').map(store.publicPlan), packages: all.filter((p) => p.kind === 'package').map(store.publicPlan),
      invoices: store.invoicesOf(emp.id), staffing: placements.forClient(emp), payments: db.where(TXNS, 'employerId', emp.id).filter((t) => t.status !== 'created').slice(0, 50),
      profile: extra.profile || store.profileOf(emp), states: S.STATES.map(([, n]) => n), inr, manage: S.employerCan(req.member, 'billing.manage'), gateway: { ready: gateway.ready, sandbox: gateway.sandbox, script: gateway.checkoutScript || '' },
      balanceOf: store.balanceOf, reasons: [],
    });
  };
  app.get('/employer/billing', requireEmployer, need('billing.view'), (req, res) => billingPage(req, res));
  const formDone = (res, r) => res.redirect(303, `/employer/billing?msg=${encodeURIComponent(r.error ? `Not changed: ${r.error}` : r.msg)}`);
  app.post('/employer/billing/change', requireEmployer, need('billing.manage'), limit('billing-change', 20), sameOrigin, (req, res) => formDone(res, changePlan(req, req.body.planId)));
  app.post('/employer/billing/cancel', requireEmployer, need('billing.manage'), limit('billing-change', 20), sameOrigin, (req, res) => formDone(res, cancelPlan(req, req.body.reason)));
  app.post('/employer/billing/resume', requireEmployer, need('billing.manage'), limit('billing-change', 20), sameOrigin, (req, res) => formDone(res, resumePlan(req)));
  app.post('/employer/billing/profile', requireEmployer, need('billing.manage'), limit('billing-profile', 20), sameOrigin, (req, res) => {
    const { errors, profile } = store.parseProfile(req.employer, req.body);
    if (errors.length) return billingPage(req, res, { errors, profile }, 400);
    saveProfile(req, profile);
    res.redirect(303, '/employer/billing?msg=' + encodeURIComponent('Billing details saved. New invoices will use them.') + '#details');
  });
  app.get('/employer/billing/invoices/:id', requireEmployer, need('billing.view'), (req, res, next) => {
    const inv = find(INVOICES, 'id', req.params.id);
    if (!inv || inv.employerId !== req.employer.id) return next();
    renderInvoice(res, inv, '/employer/billing', `/employer/billing/invoices/${inv.id}/credit-notes`);
  });
  app.get('/employer/billing/invoices/:id/credit-notes/:cnId', requireEmployer, need('billing.view'), (req, res, next) => {
    const inv = find(INVOICES, 'id', req.params.id);
    const cn = inv && inv.employerId === req.employer.id && (inv.creditNotes || []).find((c) => c.id === req.params.cnId);
    if (!cn) return next();
    renderInvoice(res, inv, `/employer/billing/invoices/${inv.id}`, `/employer/billing/invoices/${inv.id}/credit-notes`, cn);
  });
  app.get('/employer/billing/receipts/:id', requireEmployer, need('billing.view'), (req, res, next) => {
    const t = find(TXNS, 'id', req.params.id);
    if (!t || t.employerId !== req.employer.id || !SETTLED.includes(t.status)) return next();
    res.set('Cache-Control', 'no-store');
    res.render('receipt', { title: `Receipt ${t.paymentId}`, page: 'invoice', noindex: true, txn: t, inv: t.resultInvoiceId ? find(INVOICES, 'id', t.resultInvoiceId) : null, seller: store.seller(), company: req.employer, inr, back: '/employer/billing' });
  });

  // ---------- the team's billing desk ----------
  const gate = (action) => (req, res, next) => {
    if (can(req, action)) return next();
    if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, errors: ['your role does not include this'] });
    res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include billing.', noindex: true });
  };
  const toDesk = (res, view, msg) => res.redirect(303, `/admin/billing?view=${view}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}`);
  const companies = () => clients.read();
  function desk(req, res, extra = {}, status = 200) {
    res.set('Cache-Control', 'no-store');
    const view = ['overview', 'plans', 'subscriptions', 'payments', 'invoices', 'refunds', 'events', 'settings'].includes(extra.view || req.query.view) ? extra.view || req.query.view : 'overview';
    const empName = Object.fromEntries(companies().map((c) => [c.id, c.company]));
    res.status(status).render('admin-billing', {
      title: 'Billing', page: 'admin', noindex: true, admin: req.admin, view, msg: clip(req.query.msg, 300), errors: [], ...extra,
      roleLabel: (S.agencyRoles.ROLE_INFO[req.admin.role] || {}).label || req.admin.role, can: (a) => can(req, a),
      plans: store.plans(), subs: db.all(SUBS), txns: db.all(TXNS).slice(0, 300), invoices: db.all(INVOICES).slice(0, 300), refunds: db.all(REFUNDS), events: db.all(EVENTS).slice(0, 200),
      recon: reconciliation(), mrr: mrr(), settings: store.settings(), empName, companies: companies(), gateway: { name: gateway.name, label: gateway.label, ready: gateway.ready, sandbox: gateway.sandbox, webhooks: gateway.webhooks },
      inr, reasons: S.REFUND_REASONS, modes: S.OFFLINE_MODES, intervals: S.INTERVALS, balanceOf: store.balanceOf, refundable, formatYmd, me: req.admin,
    });
  }
  app.get('/admin/billing', adminAuth, gate('subscriptions.view'), (req, res) => desk(req, res));
  app.get('/admin/billing/payments.csv', adminAuth, gate('subscriptions.view'), (req, res) => {
    const empName = Object.fromEntries(companies().map((c) => [c.id, c.company]));
    team.log(req.admin, 'Exported online payments (CSV)');
    sendCsv(res, 'payments', db.all(TXNS).map((t) => ({
      created: t.createdAt, paid: t.paidAt || '', company: empName[t.employerId] || t.employerId, for: t.label, purpose: t.purpose, status: t.status,
      amount: rupees(t.amountPaise).toFixed(2), refunded: rupees(t.refundedPaise || 0).toFixed(2), currency: t.currency, provider: t.provider, order: t.orderId, payment: t.paymentId || '',
      invoice: t.resultInvoiceId ? (find(INVOICES, 'id', t.resultInvoiceId) || {}).number || '' : '',
    })));
  });
  // Plans: create and edit (Admins).
  const planPage = (req, res, plan, errors = [], status = 200) => desk(req, res, { view: 'plans', editing: plan, errors }, status);
  app.get('/admin/billing/plans/new', adminAuth, gate('plans.manage'), (req, res) => planPage(req, res, { kind: req.query.kind === 'package' ? 'package' : 'subscription', active: true, interval: 'month', gstPercent: billingOf(site).gstPercent, features: [] }));
  app.get('/admin/billing/plans/:id', adminAuth, gate('plans.manage'), (req, res, next) => {
    const p = store.planById(req.params.id);
    return p ? planPage(req, res, p) : next();
  });
  app.post('/admin/billing/plans', adminAuth, gate('plans.manage'), sameOrigin, (req, res) => {
    const { errors, plan } = store.parsePlan(req.body);
    if (errors.length) return planPage(req, res, { ...plan, features: plan.features }, errors, 400);
    const p = add(store.PLANS, { ...plan, version: 1 });
    trust.record(req.admin, 'billing-plan-created', { entityType: 'plan', entityId: p.id, reason: 'new plan', detail: `${p.name}: ${p.pricePaise == null ? 'custom quote' : inr(p.pricePaise)} ${p.interval || 'one time'}, jobs ${p.jobLimit ?? 'no limit'}, seats ${p.seatLimit ?? 'no limit'}, GST ${p.gstPercent}%` });
    team.log(req.admin, `Created the ${p.name} plan`, p.id);
    toDesk(res, 'plans', `Created ${p.name}`);
  });
  app.post('/admin/billing/plans/:id', adminAuth, gate('plans.manage'), sameOrigin, (req, res, next) => {
    const old = store.planById(req.params.id);
    if (!old) return next();
    const { errors, plan } = store.parsePlan(req.body, old);
    if (errors.length) return planPage(req, res, { ...old, ...plan }, errors, 400);
    if (old.pricePaise === 0 && plan.pricePaise !== 0 && !old.custom && store.freePlan() && store.freePlan().id === old.id) errors.push('This is the free plan companies fall back to: make another free plan first');
    if (errors.length) return planPage(req, res, { ...old, ...plan }, errors, 400);
    const changed = Object.keys(plan).filter((k) => JSON.stringify(plan[k]) !== JSON.stringify(old[k]));
    const next2 = store.put(store.PLANS, { ...old, ...plan, version: (old.version || 1) + 1, updatedBy: req.admin.name });
    trust.record(req.admin, 'billing-plan-changed', { entityType: 'plan', entityId: old.id, reason: clip(req.body.reason, 200) || 'plan updated', detail: changed.map((k) => `${k}: ${JSON.stringify(old[k])} → ${JSON.stringify(plan[k])}`).join('; ').slice(0, 900) || 'no change' });
    team.log(req.admin, `Changed the ${next2.name} plan`, changed.join(', '));
    toDesk(res, 'plans', `Saved ${next2.name}. Existing subscribers keep their price until renewal; limits apply now.`);
  });
  app.post('/admin/billing/settings', adminAuth, gate('plans.manage'), sameOrigin, (req, res) => {
    const grace = Number(req.body.graceDays);
    const days = [...new Set(String(req.body.reminderDays || '').split(/[,\s]+/).filter(Boolean).map(Number))].sort((a, b) => b - a);
    const errors = [];
    if (!Number.isInteger(grace) || grace < 0 || grace > 30) errors.push('Grace period must be 0–30 days');
    if (!days.length || days.length > 5 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 30)) errors.push('Reminders: up to 5 numbers of days from 1 to 30, e.g. 7, 3, 1');
    if (errors.length) return desk(req, res, { view: 'settings', errors }, 400);
    store.saveSettings({ graceDays: grace, reminderDays: days });
    trust.record(req.admin, 'billing-settings-changed', { entityType: 'policy', reason: 'renewal settings', detail: `grace ${grace} days, reminders ${days.join(', ')}` });
    toDesk(res, 'settings', 'Saved');
  });
  // A company's plan set by the team: an agreed Enterprise quote, or a correction.
  // The company comes from the form (the desk) or the address (scripts).
  const setPlan = (req, res, next) => {
    const emp = companies().find((c) => c.id === (req.params.id || clip(req.body.company, 60)));
    if (!emp) return next();
    const plan = store.planById(req.body.planId);
    const reason = clip(req.body.reason, 300);
    const lim = (k) => (clip(req.body[k], 4) === '' ? null : Number(req.body[k]));
    const overrides = { jobLimit: lim('jobLimit'), seatLimit: lim('seatLimit') };
    const until = clip(req.body.until, 10);
    const errors = [];
    if (!plan || plan.kind !== 'subscription') errors.push('Choose a plan');
    if (!reason) errors.push('Give a reason (it goes in the audit history)');
    for (const [k, v] of Object.entries(overrides)) if (v != null && !(Number.isInteger(v) && v >= 0 && v <= (k === 'jobLimit' ? S.HARD_JOB_CAP : S.HARD_SEAT_CAP))) errors.push(`${k === 'jobLimit' ? 'Job limit' : 'Seats'} must be 0–50 or blank`);
    if (until && !(/^\d{4}-\d{2}-\d{2}$/.test(until) && until > todayIst())) errors.push('The end date must be in the future');
    if (errors.length) return toDesk(res, 'subscriptions', `Not changed: ${errors.join('; ')}`);
    const sub = store.subOf(emp.id);
    store.changeSub(emp, sub, { planId: plan.id, plan: store.snapshot(plan), status: 'active', periodStart: todayIst(), periodEnd: until || null, cancelAtPeriodEnd: Boolean(until) && plan.custom, nextPlanId: null, graceEnds: null, overrides, setByTeam: true, reminders: [] }, 'set-by-team', req.admin.name);
    trust.record(req.admin, 'billing-plan-assigned', { entityType: 'employer', entityId: emp.id, reason, detail: `${emp.company}: ${plan.name}, jobs ${overrides.jobLimit ?? 'plan'}, seats ${overrides.seatLimit ?? 'plan'}${until ? `, until ${until}` : ''}` });
    clients.team.audit(emp.id, null, 'plan-changed', `Set to ${plan.name} by the Hireriv team`);
    toDesk(res, 'subscriptions', `${emp.company} is on ${plan.name}`);
  };
  app.post('/admin/billing/company-plan', adminAuth, gate('subscriptions.manage'), sameOrigin, (req, res, next) => setPlan(req, res, next));
  app.post('/admin/billing/companies/:id/plan', adminAuth, gate('subscriptions.manage'), sameOrigin, (req, res, next) => setPlan(req, res, next));
  // An invoice the team issues (an agreed Enterprise fee): paid online or by transfer.
  const issueTeamInvoice = (req, res, next) => {
    const emp = companies().find((c) => c.id === (req.params.id || clip(req.body.company, 60)));
    if (!emp) return next();
    const amount = S.paiseIn(req.body.amount);
    const gst = Number(req.body.gstPercent);
    const text = clip(req.body.description, 200);
    const sac = clip(req.body.sac, 8);
    const dueDays = Number(req.body.dueDays);
    const errors = [];
    if (!text) errors.push('Describe the service');
    if (!(amount > 0)) errors.push('Enter the amount before GST');
    if (!(Number.isFinite(gst) && gst >= 0 && gst <= 28)) errors.push('GST rate must be 0–28%');
    if (!/^\d{4,8}$/.test(sac)) errors.push('Enter the SAC for this service');
    if (!(Number.isInteger(dueDays) && dueDays >= 0 && dueDays <= 90)) errors.push('Payment terms must be 0–90 days');
    if (errors.length) return toDesk(res, 'invoices', `Not issued: ${errors.join('; ')}`);
    const buyer = store.buyerOf(emp);
    const taxType = store.taxTypeFor(buyer);
    const { taxPaise, taxLines } = S.taxOf(amount, gst, taxType);
    const inv = db.transaction(() => store.issueInvoice(emp, { kind: 'custom', dueDays, q: { lines: [{ text, sac, amountPaise: amount }], subtotalPaise: amount, gstPercent: gst, taxType, taxLines, taxPaise, totalPaise: amount + taxPaise, currency: S.CURRENCY, buyer, period: null } }));
    trust.record(req.admin, 'billing-invoice-issued', { entityType: 'invoice', entityId: inv.id, reason: text, detail: `${inv.number} · ${emp.company} · ${inr(inv.totalPaise)}` });
    tellCompany(emp, `billing:invoice:${inv.id}`, { title: `Invoice ${inv.number}`, body: `${inr(inv.totalPaise)} due by ${formatYmd(inv.dueDate)}`, subject: `Invoice ${inv.number} from ${site.name}`, intro: `invoice ${inv.number} for ${inr(inv.totalPaise)} is ready (${text}). It is due by ${formatYmd(inv.dueDate)}; you can pay it online from Billing.` });
    toDesk(res, 'invoices', `Issued ${inv.number}`);
  };
  app.post('/admin/billing/company-invoices', adminAuth, gate('invoices.issue'), sameOrigin, (req, res, next) => issueTeamInvoice(req, res, next));
  app.post('/admin/billing/companies/:id/invoices', adminAuth, gate('invoices.issue'), sameOrigin, (req, res, next) => issueTeamInvoice(req, res, next));
  app.get('/admin/billing/invoices/:id', adminAuth, gate('subscriptions.view'), (req, res, next) => {
    const inv = find(INVOICES, 'id', req.params.id);
    if (!inv) return next();
    renderInvoice(res, inv, '/admin/billing?view=invoices', `/admin/billing/invoices/${inv.id}/credit-notes`);
  });
  app.get('/admin/billing/invoices/:id/credit-notes/:cnId', adminAuth, gate('subscriptions.view'), (req, res, next) => {
    const inv = find(INVOICES, 'id', req.params.id);
    const cn = inv && (inv.creditNotes || []).find((c) => c.id === req.params.cnId);
    if (!cn) return next();
    renderInvoice(res, inv, `/admin/billing/invoices/${inv.id}`, `/admin/billing/invoices/${inv.id}/credit-notes`, cn);
  });
  // A bank transfer or cheque for a team-issued invoice (recording money is separate from issuing).
  app.post('/admin/billing/invoices/:id/payments', adminAuth, gate('invoices.issue'), sameOrigin, (req, res, next) => {
    const inv = find(INVOICES, 'id', req.params.id);
    if (!inv) return next();
    const amount = S.paiseIn(req.body.amount);
    const date = clip(req.body.date, 10);
    const mode = clip(req.body.mode, 20);
    const reference = clip(req.body.reference, 120);
    const errors = [];
    if (inv.transactionId) errors.push('this invoice was paid online');
    if (!(amount > 0) || amount > store.balanceOf(inv)) errors.push(`enter an amount up to ${inr(store.balanceOf(inv))}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayIst() || date < inv.date) errors.push('the date must be between the invoice date and today');
    if (!S.OFFLINE_MODES.includes(mode)) errors.push('choose how it was paid');
    if (!reference) errors.push('enter the bank or cheque reference');
    if (errors.length) return toDesk(res, 'invoices', `Not recorded: ${errors.join('; ')}`);
    db.transaction(() => {
      inv.payments = [...(inv.payments || []), { id: crypto.randomUUID(), date, amountPaise: amount, mode, reference, recordedBy: req.admin.name }];
      store.refreshInvoice(inv);
      put(INVOICES, inv);
    });
    trust.record(req.admin, 'billing-payment-recorded', { entityType: 'invoice', entityId: inv.id, reason: mode, detail: `${inv.number} · ${inr(amount)} · ${reference}` });
    toDesk(res, 'invoices', `Recorded ${inr(amount)} on ${inv.number}`);
  });
  app.post('/admin/billing/reconcile', adminAuth, gate('subscriptions.view'), sameOrigin, async (req, res) => {
    const r = await reconcileOrders({ olderThanMs: 0 });
    team.log(req.admin, 'Checked open payments with the provider', `${r.checked} checked, ${r.settled} settled`);
    toDesk(res, 'overview', `Checked ${r.checked} open payment${r.checked === 1 ? '' : 's'} with the provider: ${r.settled} settled, ${r.expired} closed`);
  });

  // Refunds: JSON for the API, forms for the desk; both need the password again.
  const refundForm = (fn) => async (req, res) => {
    const r = await fn(req);
    if (req.path.startsWith('/api/')) return res.status(r.status || (r.error || r.errors ? 400 : 200)).json(r.error || r.errors ? { ok: false, errors: r.errors || [r.error] } : { ok: true, refund: refundJson(r.refund || r.rec) });
    toDesk(res, 'refunds', r.error || r.errors ? `Not done: ${(r.errors || [r.error]).join('; ')}` : r.status === 201 ? 'Refund asked for: someone else must approve it' : `Refund ${(r.refund || r.rec).status}`);
  };
  const refundJson = (r) => r && ({ id: r.id, transactionId: r.transactionId, amountPaise: r.amountPaise, reason: r.reason, status: r.status, requestedBy: r.requestedBy && r.requestedBy.name, approvedBy: r.approvedBy && r.approvedBy.name, creditNote: r.creditNoteNumber || null, providerRefundId: r.providerRefundId || null, createdAt: r.createdAt });
  const asking = refundForm((req) => requestRefund(req.admin, req.body || {}));
  const deciding = (decision) => refundForm((req) => decideRefund(req.admin, req.params.id, decision, (req.body || {}).note));
  const approving = deciding('approve');
  const rejecting = deciding('reject');
  app.post('/api/admin/billing/refunds', adminAuth, gate('billing.refund'), limit('billing-refunds', 30), sameOrigin, requireConfirmed, (req, res) => asking(req, res));
  app.post('/api/admin/billing/refunds/:id/approve', adminAuth, gate('billing.refund'), limit('billing-refunds', 30), sameOrigin, requireConfirmed, (req, res) => approving(req, res));
  app.post('/api/admin/billing/refunds/:id/reject', adminAuth, gate('billing.refund'), limit('billing-refunds', 30), sameOrigin, requireConfirmed, (req, res) => rejecting(req, res));
  app.post('/admin/billing/refunds', adminAuth, gate('billing.refund'), limit('billing-refunds', 30), sameOrigin, requireConfirmed, (req, res) => asking(req, res));
  app.post('/admin/billing/refunds/:id/approve', adminAuth, gate('billing.refund'), limit('billing-refunds', 30), sameOrigin, requireConfirmed, (req, res) => approving(req, res));
  app.post('/admin/billing/refunds/:id/reject', adminAuth, gate('billing.refund'), limit('billing-refunds', 30), sameOrigin, requireConfirmed, (req, res) => rejecting(req, res));
  app.get('/api/admin/billing/refunds', adminAuth, gate('subscriptions.view'), (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, refunds: db.all(REFUNDS).map(refundJson) }));

  return { daily, renewals, reconcileOrders, reconciliation, settle, mrr, subscriptionJson };
}

module.exports = { register };
