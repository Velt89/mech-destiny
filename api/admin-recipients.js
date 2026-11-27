'use strict';
const { sendJson, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * GET /api/admin-recipients — admin-only list of A2U payout recipients.
 * Every user who has signed into the app (uid + username) with whether they
 * already received a completed A2U payout. Used to pay the 5 unique wallets
 * Pi requires on the paired Testnet app before approving a Mainnet outgoing
 * wallet: the caller needs each recipient's Pi uid, which only the backend
 * store holds (uids are app-local and never shown in the public leaderboard).
 *
 * Gates (same as POST /api/payout): Sandbox only (PI_SANDBOX=false -> 403),
 * PI_ADMIN_TOKEN must be set (else 503) and the X-Admin-Token header must
 * match it (else 401). No wallet seed needed — this endpoint sends nothing.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (process.env.PI_SANDBOX === 'false') {
    return sendJson(res, 403, { error: 'admin endpoints are disabled outside Sandbox (PI_SANDBOX=false)' });
  }
  const adminToken = process.env.PI_ADMIN_TOKEN || '';
  if (!adminToken) {
    return sendJson(res, 503, { error: 'admin endpoints are not configured (PI_ADMIN_TOKEN is not set)' });
  }
  if (req.headers['x-admin-token'] !== adminToken) {
    return sendJson(res, 401, { error: 'unauthorized — X-Admin-Token header is missing or wrong' });
  }
  if (!(await store.requireLoad(res))) return;
  const recipients = store.listPayoutRecipients();
  return sendJson(res, 200, {
    recipients,
    unpaidCount: recipients.filter((r) => !r.paidCompleted).length,
    paidCount: recipients.filter((r) => r.paidCompleted).length,
  });
};
