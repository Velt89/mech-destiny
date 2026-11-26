'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * POST /api/battle — 1 free battle per UTC day, absolute stakes.
 *
 * New 2-step flow (2026-11-26):
 *   { action: 'preview' }            -> show the enemy first (no battle used)
 *   { action: 'reroll', matchId }    -> 1 reroll per match, new rival
 *   { action: 'fight', matchId }     -> resolve the previewed match
 *   { action: 'surrender', matchId } -> only after the reroll is used;
 *                                       -25 pts (floor 0), no part lost/gained
 * Legacy: no action (or 'fight' without matchId) -> immediate fight, as before
 * (battleId idempotency key still required for the legacy path).
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (!body.uid) return sendJson(res, 400, { error: 'uid is required' });
  if (!(await store.requireLoad(res))) return;
  const action = body.action || 'fight';
  let result;
  if (action === 'preview') {
    result = store.previewBattle(body.uid, body.username);
  } else if (action === 'reroll') {
    if (!body.matchId) return sendJson(res, 400, { error: 'matchId is required' });
    result = store.rerollBattle(body.uid, body.username, { matchId: body.matchId });
  } else if (action === 'fight' && body.matchId) {
    result = store.fightBattle(body.uid, body.username, { matchId: body.matchId, battleId: body.battleId });
  } else if (action === 'fight') {
    result = store.doBattle(body.uid, body.username, { battleId: body.battleId });
  } else if (action === 'surrender') {
    if (!body.matchId) return sendJson(res, 400, { error: 'matchId is required' });
    result = store.surrenderBattle(body.uid, body.username, { matchId: body.matchId });
  } else {
    return sendJson(res, 400, { error: `unknown action: ${action} (use preview, reroll, fight, surrender)` });
  }
  if (!(await store.requireSave(res))) return; // preview creates a match; fight/surrender mutate
  if (result.error) return sendJson(res, 400, result);
  sendJson(res, 200, result);
};
