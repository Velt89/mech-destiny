'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');
const pi = require('./_lib/pi');

/**
 * POST /api/payment-complete — step 2 of the Pi payment handshake.
 * Called from the frontend's Pi.createPayment onReadyForServerCompletion callback.
 * Body: { paymentId, txid, uid, username? }
 * Rewards are granted ONLY after the Platform API complete call succeeds
 * (or the Sandbox simulation succeeds). Never grant on the client-side
 * callback alone — the client can lie; the server call cannot.
 *
 * kind 'draw': grants the paid draws (min Rare, Ethereal Fate pity applied)
 *   and adds 10% of the amount to the reward pool.
 * kind 'shop-buy': transfers the listed part to the buyer and credits the
 *   seller's Pi ledger (TODO: real Pi settlement to the seller).
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (!body.paymentId) return sendJson(res, 400, { error: 'paymentId is required' });
  if (!body.uid) return sendJson(res, 400, { error: 'uid is required' });
  const existing = store.getPayment(body.paymentId);
  if (existing && existing.status === 'completed') {
    return sendJson(res, 200, { ok: true, alreadyCompleted: true, status: 'completed' });
  }
  store.recordPayment(body.paymentId, body.uid, body.amount || null);
  try {
    const result = await pi.completePayment(body.paymentId, body.txid);
    store.setPaymentStatus(body.paymentId, 'completed', body.txid);
    const payment = store.getPayment(body.paymentId);
    if (payment && payment.kind === 'draw' && payment.drawType) {
      const draws = store.grantDraws(body.uid, body.username, payment.drawType);
      if (draws.error) return sendJson(res, 400, { ...draws, status: 'completed' });
      const poolTotal = store.addToPool(payment.amount || store.DRAW_ODDS[payment.drawType].price);
      return sendJson(res, 200, { ...result, status: 'completed', kind: 'draw', drawType: payment.drawType, draws, poolTotal });
    }
    if (payment && payment.kind === 'shop-buy' && payment.listingId) {
      const sale = store.completeShopSale(payment.listingId, body.uid, body.username);
      if (sale.error) return sendJson(res, 400, { ...sale, status: 'completed' });
      return sendJson(res, 200, { ...result, status: 'completed', kind: 'shop-buy', sale });
    }
    return sendJson(res, 200, { ...result, status: 'completed', note: 'payment completed but no reward kind was recorded for it' });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: `Pi complete failed: ${e.message}` });
  }
};
