'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * POST /api/battle — 1 free battle per UTC day, absolute stakes.
 * Body: { uid, username?, battleId }
 * battleId is an idempotency key. Outcome is computed server-side from squad
 * stats (Power primary, Speed/Armor in the score). Loser loses 1 random part
 * to the winner; a win earns Blueprint Fragments. Scaffold rival is a bot
 * (real PvP matching is a TODO).
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (!body.uid) return sendJson(res, 400, { error: 'uid is required' });
  const result = store.doBattle(body.uid, body.username, { battleId: body.battleId });
  if (result.error) return sendJson(res, 400, result);
  sendJson(res, 200, result);
};
