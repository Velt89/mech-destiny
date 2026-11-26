'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * /api/shop — the Pi shop (listings + trade offers).
 *   GET  /api/shop                    -> active listings + your open offers
 *   POST /api/shop { action: 'create-listing', uid, partId, pricePi }
 *   POST /api/shop { action: 'create-offer', uid, toUid, offeredPartId, wantedPartId?, pricePi? }
 *   POST /api/shop { action: 'accept-offer', uid, offerId }
 * Buying a listing goes through the Pi payment flow (kind 'shop-buy'):
 * the part changes owner in /api/payment-complete, never here.
 * All ownership changes happen server-side only.
 */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const uid = url.searchParams.get('uid');
    if (!(await store.requireLoad(res))) return;
    return sendJson(res, 200, {
      listings: store.listListings(),
      offersForYou: uid ? store.listOffersFor(uid) : [],
      utcDay: store.utcDay(),
    });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (!body.uid) return sendJson(res, 400, { error: 'uid is required' });
  if (!(await store.requireLoad(res))) return;
  let result;
  if (body.action === 'create-listing') {
    result = store.createListing(body.uid, body.username, { partId: body.partId, pricePi: body.pricePi });
  } else if (body.action === 'create-offer') {
    result = store.createOffer(body.uid, body.username, { toUid: body.toUid, offeredPartId: body.offeredPartId, wantedPartId: body.wantedPartId, pricePi: body.pricePi });
  } else if (body.action === 'accept-offer') {
    result = store.acceptOffer(body.uid, body.username, { offerId: body.offerId });
  } else {
    return sendJson(res, 400, { error: `unknown action: ${body.action} (use create-listing, create-offer, accept-offer)` });
  }
  if (!(await store.requireSave(res))) return; // create/accept mutate; getUser may also have created the user
  if (result.error) return sendJson(res, 400, result);
  sendJson(res, 200, result);
};
