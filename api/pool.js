'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * /api/pool — the reward pool.
 *   GET  /api/pool -> total, paid out, last weekly payout.
 *   POST /api/pool { action: 'payout' } -> run the weekly payout: top 3 in
 *     match ranking split 10% of the pool (1st 5%, 2nd 3%, 3rd 2%).
 *     Scaffold: credits winners' Pi ledger (real Pi transfer is a TODO).
 *     In production this must be a scheduled/admin-only job, not a public call.
 */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    if (!(await store.requireLoad(res))) return;
    return sendJson(res, 200, store.getPool());
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (body.action !== 'payout') return sendJson(res, 400, { error: "unknown action (use 'payout')" });
  if (!(await store.requireLoad(res))) return;
  const result = store.weeklyPayout();
  if (!(await store.requireSave(res))) return;
  sendJson(res, 200, result);
};
