'use strict';
/**
 * Mech Destiny — Pi Platform API helpers (server-side only).
 *
 * The Server API Key lives ONLY here (env PI_SERVER_API_KEY). It must never
 * appear in client-side code, logs, or the frontend bundle.
 *
 * Sandbox mode (PI_SANDBOX=true, default): no real Pi moves. verifyAccessToken
 * returns verified:false unless DEV_ALLOW_MOCK_AUTH=true (local dev only), and
 * approve/completePayment run as clearly-labelled simulations. Flip sandbox off
 * only after the Sandbox handshake passes end-to-end in Pi Browser.
 *
 * Real flow (per Pi docs):
 *   GET  https://api.minepi.com/v2/me
 *   POST https://api.minepi.com/v2/payments/{id}/approve
 *   POST https://api.minepi.com/v2/payments/{id}/complete  { paymentId, txid }
 */

const PLATFORM_API = 'https://api.minepi.com/v2';
const sandbox = process.env.PI_SANDBOX !== 'false';
const serverKey = process.env.PI_SERVER_API_KEY || '';
const mockAuth = process.env.DEV_ALLOW_MOCK_AUTH === 'true';

function isSandbox() { return sandbox; }
function hasServerKey() { return serverKey.length > 0; }

async function platformFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(PLATFORM_API + path, {
    method,
    headers: {
      Authorization: `Key ${serverKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Pi Platform API ${method} ${path} -> HTTP ${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

/**
 * Verify a Pi access token from Pi.authenticate().
 * Returns { verified, uid, username, sandbox, note }.
 * The frontend user object is presentation-only — never trust it server-side.
 */
async function verifyAccessToken(accessToken) {
  if (!accessToken) return { verified: false, note: 'no access token supplied' };
  if (!hasServerKey()) {
    if (mockAuth) {
      // LOCAL DEV ONLY. Deterministic mock uid from the token, so the auth UI
      // can be exercised before registration. Never enable on Vercel.
      const hash = Buffer.from(accessToken).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
      return { verified: true, uid: `mock-${hash}`, username: 'Sandbox Pioneer', sandbox: true, mock: true,
        note: 'DEV_ALLOW_MOCK_AUTH mock — NOT a real Pi identity. Set PI_SERVER_API_KEY for real verification.' };
    }
    return { verified: false, sandbox,
      note: 'PI_SERVER_API_KEY is not configured — backend cannot verify this token. Set it in Vercel env / .env, then retry.' };
  }
  const res = await fetch(PLATFORM_API + '/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = new Error(`Pi /me -> HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return { verified: true, uid: data.uid, username: data.username, sandbox, mock: false };
}

/** Approve a Pi payment server-side (step 1 of 2). Sandbox without a key = simulation. */
async function approvePayment(paymentId) {
  if (!hasServerKey()) {
    return { ok: true, sandbox: true, simulated: true, paymentId,
      note: 'Sandbox simulation — no Platform API call (PI_SERVER_API_KEY not set).' };
  }
  await platformFetch(`/payments/${encodeURIComponent(paymentId)}/approve`, { method: 'POST' });
  return { ok: true, sandbox, simulated: false, paymentId };
}

/** Complete a Pi payment server-side (step 2 of 2). Sandbox without a key = simulation. */
async function completePayment(paymentId, txid) {
  if (!hasServerKey()) {
    return { ok: true, sandbox: true, simulated: true, paymentId, txid: txid || null,
      note: 'Sandbox simulation — no Platform API call (PI_SERVER_API_KEY not set).' };
  }
  await platformFetch(`/payments/${encodeURIComponent(paymentId)}/complete`, {
    method: 'POST', body: { paymentId, txid },
  });
  return { ok: true, sandbox, simulated: false, paymentId, txid };
}

module.exports = { isSandbox, hasServerKey, verifyAccessToken, approvePayment, completePayment };
