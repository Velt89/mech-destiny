'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * POST /api/checkin — idempotent daily check-in.
 * Body: { uid, username? }  (uid = verified Pi uid from /api/me, or a guest uid)
 * Same UTC day twice -> alreadyClaimed:true, no double points, no double part.
 * First check-in grants the Base Machine + 1 part. Streak day 3 -> Rare,
 * day 7 -> Epic, day 14 -> Legendary. Miss a day -> streak resets to 1.
 * After day 14, drops are random again. At the 50-part inventory cap the
 * part is skipped (inventoryFull:true) but points and streak still count.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (!body.uid || typeof body.uid !== 'string') {
    return sendJson(res, 400, { error: 'uid is required' });
  }
  if (!(await store.requireLoad(res))) return;
  const result = store.claimDaily(body.uid, body.username);
  if (!(await store.requireSave(res))) return;
  sendJson(res, 200, result);
};
