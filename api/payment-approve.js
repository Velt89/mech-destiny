'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');
const pi = require('./_lib/pi');

/**
 * POST /api/payment-approve — step 1 of the Pi payment handshake.
 * Called from the frontend's Pi.createPayment onReadyForServerApproval callback.
 * Body: { paymentId, uid, amount?, kind, drawType?, listingId? }
 *   kind: 'draw' (drawType = standard|forge|pack10) or 'shop-buy' (listingId).
 * Refuses approval while the buyer's inventory cannot fit the draws, so a
 * paid draw is never granted into a full inventory. Sandbox without a key:
 * clearly-labelled simulation — no Platform API call, no real Pi moves.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (!body.paymentId) return sendJson(res, 400, { error: 'paymentId is required' });
  if (!body.uid) return sendJson(res, 400, { error: 'uid is required' });
  if (body.kind === 'draw') {
    const cfg = store.DRAW_ODDS[body.drawType];
    if (!cfg) return sendJson(res, 400, { error: `unknown draw type: ${body.drawType}` });
    const u = store.getUser(body.uid);
    if (u.parts.length + cfg.draws > store.INVENTORY_CAP) {
      return sendJson(res, 409, { error: `inventory full — merge, sell or trade to make room for ${cfg.draws} draw(s) (${u.parts.length}/${store.INVENTORY_CAP} parts)` });
    }
  }
  if (body.kind === 'shop-buy') {
    const listing = store.getListing(body.listingId);
    if (!listing || listing.status !== 'active') return sendJson(res, 409, { error: 'listing is no longer available' });
    if (listing.sellerUid === body.uid) return sendJson(res, 400, { error: 'you cannot buy your own listing' });
  }
  store.recordPayment(body.paymentId, body.uid, body.amount || null, { kind: body.kind, drawType: body.drawType, listingId: body.listingId });
  try {
    const result = await pi.approvePayment(body.paymentId);
    store.setPaymentStatus(body.paymentId, 'approved');
    sendJson(res, 200, { ...result, status: 'approved' });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: `Pi approve failed: ${e.message}` });
  }
};
