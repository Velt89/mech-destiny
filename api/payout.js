'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');
const a2u = require('./_lib/a2u');

/**
 * POST /api/payout — admin-only App-to-User (A2U) Pi payout (Testnet).
 *
 * Body: { payoutId, uid, amount, memo?, reason?, username? }
 *   payoutId  client-chosen idempotency key — a replay returns the stored
 *             result without paying twice.
 *   uid       Pi uid of the recipient (their wallet address is resolved by
 *             Pi itself from the payment object — never supplied by the caller).
 *   amount    Pi to send, 0 < amount <= 1 (per-payout cap).
 *   memo      optional memo for the Pi payment (default "Mech Destiny test payout").
 *
 * Hard gates, in order:
 *   1. PI_SANDBOX must be "true" (anything else -> 403). Never runs on Mainnet.
 *   2. PI_ADMIN_TOKEN must be set (else 503, endpoint disabled) and the
 *      X-Admin-Token header must match it (else 401).
 *   3. PI_APP_WALLET_SECRET must be set (else 503 "app wallet not configured").
 *      There is deliberately NO simulated payout — without the seed, nothing pays.
 *
 * Flow (inside the one-at-a-time A2U lock — Pi sequence-number safety):
 *   load state -> replay check -> executeA2UPayout (create -> build -> sign
 *   -> submit -> complete) -> record -> save. Failures are recorded as
 *   status 'failed' with a sanitised error (no seed, no token, ever).
 *
 * This is the flow that produces the 5 unique-wallet A2U transactions Pi
 * requires before approving a Mainnet outgoing wallet. Recipients must have
 * granted the app the wallet_address scope, or Pi refuses with missing_scope.
 */
function adminToken() { return process.env.PI_ADMIN_TOKEN || ''; }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  // Gate 1 — Sandbox / Testnet only. PI_SANDBOX=false means Mainnet: refuse.
  if (process.env.PI_SANDBOX === 'false') {
    return sendJson(res, 403, { error: 'A2U payouts are disabled outside Sandbox (PI_SANDBOX=false) — this endpoint never runs against Mainnet' });
  }
  // Gate 2 — admin token must be configured, and the request must carry it.
  if (!adminToken()) {
    return sendJson(res, 503, { error: 'admin payouts are not configured (PI_ADMIN_TOKEN is not set)' });
  }
  if (req.headers['x-admin-token'] !== adminToken()) {
    return sendJson(res, 401, { error: 'unauthorized — X-Admin-Token header is missing or wrong' });
  }
  // Gate 3 — app wallet seed must be configured. No fallback, no simulation.
  if (!process.env.PI_APP_WALLET_SECRET) {
    return sendJson(res, 503, { error: 'app wallet not configured (PI_APP_WALLET_SECRET is not set)' });
  }

  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  const inputError = a2u.validatePayoutInput(body);
  if (inputError) return sendJson(res, 400, { error: inputError });
  const memo = typeof body.memo === 'string' && body.memo.length > 0
    ? body.memo.slice(0, 128)
    : 'Mech Destiny test payout';

  // The whole check-then-pay-then-record sequence runs under the A2U lock so
  // two concurrent requests (same payoutId or not) can never double-pay or
  // interleave sequence numbers.
  const outcome = await a2u.withA2ULock(async () => {
    try { await store.loadState(); }
    catch (e) { return { status: 500, body: { error: `persistent store unavailable: ${e.message}` } }; }

    const existing = store.getPayout(body.payoutId);
    if (existing) {
      return { status: 200, body: { ok: true, replay: true, payout: existing } };
    }

    let result;
    try {
      result = await a2u.executeA2UPayout({
        uid: body.uid,
        amount: Number(body.amount),
        memo,
        metadata: { payoutId: body.payoutId, reason: body.reason || 'test payout', app: 'mech-destiny' },
      });
    } catch (e) {
      const failed = store.recordPayout({
        payoutId: body.payoutId,
        uid: body.uid,
        username: body.username || null,
        amount: Number(body.amount),
        memo,
        reason: body.reason || null,
        paymentId: e.paymentId || null,
        recipient: e.recipient || null,
        txid: e.txid || null,
        status: 'failed',
        error: a2u.stripSecrets(e.message).slice(0, 500),
      });
      try { await store.saveState(); } catch (saveErr) {
        return { status: 500, body: { error: `persistent store unavailable: ${saveErr.message}` } };
      }
      if (e.code === 'missing_scope') {
        return { status: 400, body: { ok: false, error: 'recipient has not granted this app the wallet_address scope — they must sign in to the app in Pi Browser with that scope first', payout: failed } };
      }
      return { status: 502, body: { ok: false, error: a2u.stripSecrets(e.message).slice(0, 500), payout: failed } };
    }

    const recorded = store.recordPayout({
      payoutId: body.payoutId,
      uid: body.uid,
      username: body.username || null,
      amount: result.amount,
      memo,
      reason: body.reason || null,
      paymentId: result.paymentId,
      recipient: result.recipient,
      txid: result.txid,
      status: 'completed',
    });
    try { await store.saveState(); }
    catch (e) { return { status: 500, body: { error: `persistent store unavailable: ${e.message}` } }; }
    return { status: 200, body: { ok: true, replay: false, payout: recorded } };
  });

  return sendJson(res, outcome.status, outcome.body);
};
