'use strict';
const { sendJson, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * GET /api/payouts — public summary of App-to-User payouts.
 * Counts and totals only (total payouts, completed/failed, unique recipients,
 * total Pi paid). NO uids, usernames or wallet addresses are exposed — the
 * per-payout records stay admin-side (POST /api/payout replays return the
 * stored record to the admin caller only).
 *
 * This is the counter the team watches while working towards Pi's Mainnet
 * outgoing-wallet prerequisite: A2U transactions to 5 unique wallets on the
 * paired Testnet app.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!(await store.requireLoad(res))) return;
  return sendJson(res, 200, store.payoutSummary());
};
