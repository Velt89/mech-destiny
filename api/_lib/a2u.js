'use strict';
/**
 * Mech Destiny — App-to-User (A2U) payouts (server-side only).
 *
 * SANDBOX / TESTNET ONLY. This module implements Pi's official A2U flow
 * (pi-apps/pi-sdk-integration-guide on GitHub):
 *   1. POST api.minepi.com/v2/payments { amount, memo, metadata, uid }
 *      -> { identifier, to_address }  (recipient address comes from Pi —
 *      NEVER accept a wallet address from the caller, caller supplies uid only)
 *   2. Load the app wallet account from the Pi Testnet Horizon
 *      (https://api.testnet.minepi.com) — fresh every time, the account
 *      could have been destroyed or the user could have changed wallets.
 *   3. Build a Stellar payment tx: native asset, amount, memo =
 *      Memo.text(payment identifier). Pi identifiers are 28 chars, which is
 *      exactly the Memo.text limit — a longer identifier is a hard error,
 *      never silently truncated.
 *   4. Sign locally with the app wallet secret seed (PI_APP_WALLET_SECRET).
 *      The seed lives ONLY in env; it is never logged or returned.
 *   5. Submit to the Pi Testnet blockchain (network passphrase "Pi Testnet"
 *      — NOT the public Stellar testnet passphrase).
 *   6. POST /v2/payments/{identifier}/complete { txid }.
 *
 * Only ONE A2U payment at a time (Pi sequence-number safety): all payouts
 * run through a single in-process mutex (withA2ULock). On Vercel each
 * function instance has its own mutex — payouts are rare, admin-triggered,
 * one at a time in practice; a distributed lock is a later TODO.
 *
 * LAZY SDK LOAD: @stellar/stellar-sdk v17 is a dual ESM/CJS package
 * ("type": "module" in its package.json, with exports mapping require ->
 * ./lib/cjs/index.js and import -> ./lib/esm/index.js). A top-level
 * require() of it from this CommonJS module loads fine under plain Node,
 * but Vercel's serverless bundler mishandles it: on Vercel the whole
 * api/payout handler failed to load ("handler is not a function", HTTP 500)
 * while api/payouts (no Stellar dependency) worked. The SDK is therefore
 * loaded LAZILY via dynamic import() inside the payout path only
 * (loadStellar, cached) — requiring this module or api/payout.js never
 * touches the SDK. This mirrors api/_lib/kv.js, which already lazy-requires
 * @vercel/kv and redis inside functions for the same reason.
 *
 * Env (read per call, so tests can re-point them):
 *   PI_SANDBOX            must be "true" — anything else refuses (see api/payout.js).
 *   PI_SERVER_API_KEY     Pi Server API Key (same as U2A approve/complete).
 *   PI_APP_WALLET_SECRET  secret seed of the Testnet app wallet (S...).
 *   PI_HORIZON_URL        override for tests (default Pi Testnet Horizon).
 *   PI_PLATFORM_API_BASE  override for tests (default https://api.minepi.com/v2).
 *
 * No simulated payouts: without the seed the handler answers 503 and this
 * module is never called.
 */

/**
 * Lazy-load the Stellar SDK via dynamic import() — see the header note.
 * import() resolves the package's ESM entry (./lib/esm/index.js) and the
 * returned namespace exposes the named exports directly (Keypair,
 * Horizon.Server, TransactionBuilder, Operation, Asset, Memo). Cached so
 * concurrent payouts share one import. Never called at module load time.
 */
let stellarPromise = null;
function loadStellar() {
  if (!stellarPromise) stellarPromise = import('@stellar/stellar-sdk');
  return stellarPromise;
}

const MAX_PAYOUT_PI = 1;
const HORIZON_TESTNET_URL = 'https://api.testnet.minepi.com';
const PLATFORM_API_BASE = 'https://api.minepi.com/v2';
const NETWORK_PASSPHRASE = 'Pi Testnet'; // Pi Testnet — NOT Networks.TESTNET
const TIMEBOUNDS_SECONDS = 180;

/** Redact anything that looks like a Stellar secret seed from a message. */
function stripSecrets(text) {
  return String(text || '').replace(/S[A-Z0-9]{55}/g, '[redacted-seed]');
}

/** Format a Pi amount as a Stellar amount string (max 7 decimal places). */
function formatAmount(amount) {
  return Number(amount).toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
}

/** Validate a payout request. Returns an error string, or null when valid. */
function validatePayoutInput({ payoutId, uid, amount }) {
  if (!payoutId || typeof payoutId !== 'string') return 'payoutId is required (idempotency key, client-chosen string)';
  if (payoutId.length > 128) return 'payoutId is too long (max 128 chars)';
  if (!uid || typeof uid !== 'string') return 'uid is required (Pi uid of the recipient)';
  const n = Number(amount);
  if (!Number.isFinite(n)) return 'amount must be a number';
  if (n <= 0) return 'amount must be positive';
  if (n > MAX_PAYOUT_PI) return `amount exceeds the ${MAX_PAYOUT_PI} π per-payout cap`;
  return null;
}

async function platformPost(path, body) {
  const base = process.env.PI_PLATFORM_API_BASE || PLATFORM_API_BASE;
  const serverKey = process.env.PI_SERVER_API_KEY || '';
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { Authorization: `Key ${serverKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Pi Platform API POST ${path} -> HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    // Pi refuses A2U creation when the recipient never granted the app the
    // wallet_address scope — surface that as a clean, actionable error.
    if (JSON.stringify(data || '').includes('missing_scope')) err.code = 'missing_scope';
    throw err;
  }
  return data;
}

/** Step 1 — create the A2U payment on the Pi Platform API. */
async function createA2UPayment({ uid, amount, memo, metadata }) {
  const data = await platformPost('/payments', { amount, memo, metadata: metadata || {}, uid });
  const paymentId = data && data.identifier;
  // Real Pi responses carry the recipient as `to_address` (the guide's
  // `recipient` field is not present in live responses — see pi-nodejs
  // issue #25, which shows a real payment object). Accept either.
  const recipient = data && (data.to_address || data.recipient);
  if (!paymentId || typeof paymentId !== 'string') {
    throw new Error('Pi create payment returned no identifier');
  }
  if (!recipient || typeof recipient !== 'string' || !recipient.startsWith('G')) {
    throw new Error('Pi create payment returned no recipient wallet address');
  }
  return { paymentId, recipient };
}

/** Step 6 — complete the payment on the Pi Platform API. */
async function completeA2UPayment(paymentId, txid) {
  await platformPost(`/payments/${encodeURIComponent(paymentId)}/complete`, { txid });
}

/**
 * Steps 2–5 — load the app wallet account, build, sign and submit the
 * Stellar payment transaction on Pi Testnet.
 * `horizon` is injectable for tests; defaults to the real Pi Testnet Horizon.
 */
async function submitA2UTransaction({ paymentId, recipient, amount }, seed, horizon) {
  const StellarSdk = await loadStellar();
  const keypair = StellarSdk.Keypair.fromSecret(seed);
  const horizonUrl = process.env.PI_HORIZON_URL || HORIZON_TESTNET_URL;
  // The SDK refuses plain-http Horizon URLs unless allowHttp is set. The
  // default is Pi's https Testnet Horizon; allowHttp is only enabled when
  // the URL is explicitly overridden to http:// (local test stubs).
  const server = horizon || new StellarSdk.Horizon.Server(horizonUrl, { allowHttp: horizonUrl.startsWith('http://') });
  const account = await server.loadAccount(keypair.publicKey());
  const baseFee = await server.fetchBaseFee();
  const timebounds = await server.fetchTimebounds(TIMEBOUNDS_SECONDS);
  if (Buffer.byteLength(paymentId, 'utf8') > 28) {
    throw new Error('Pi payment identifier exceeds the 28-byte Memo.text limit — refusing to build the transaction');
  }
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: String(baseFee),
    networkPassphrase: NETWORK_PASSPHRASE,
    timebounds,
  })
    .addOperation(StellarSdk.Operation.payment({
      destination: recipient,
      asset: StellarSdk.Asset.native(),
      amount: formatAmount(amount),
    }))
    .addMemo(StellarSdk.Memo.text(paymentId))
    .build();
  tx.sign(keypair);
  const res = await server.submitTransaction(tx);
  const txid = res && (res.hash || res.id);
  if (!txid) throw new Error('Horizon submit returned no transaction hash');
  return { txid, txEnvelopeXdr: tx.toEnvelope().toXdr('base64') };
}

/**
 * Full A2U flow (steps 1–6). `overrides` is test-only dependency injection
 * ({ horizon, createPayment, completePayment }); production callers omit it.
 * Throws on any failure; the caller records the failure (never as a success).
 * Returns { paymentId, recipient, txid, amount }.
 */
async function executeA2UPayout({ uid, amount, memo, metadata }, overrides = {}) {
  const seed = process.env.PI_APP_WALLET_SECRET || '';
  if (!seed) {
    const err = new Error('app wallet not configured (PI_APP_WALLET_SECRET is not set)');
    err.code = 'no_wallet_seed';
    throw err;
  }
  const create = overrides.createPayment || createA2UPayment;
  const complete = overrides.completePayment || completeA2UPayment;
  const created = await create({ uid, amount, memo, metadata });
  let txid;
  try {
    const submitted = await submitA2UTransaction(
      { paymentId: created.paymentId, recipient: created.recipient, amount },
      seed,
      overrides.horizon || null,
    );
    txid = submitted.txid;
  } catch (e) {
    // The payment was created on Pi but the chain tx never landed — leave it
    // un-completed on Pi's side (it will surface as an incomplete payment)
    // and report the failure; the payoutId stays recorded as failed so a
    // retry with the SAME payoutId does not silently create a second payment.
    const err = new Error(`A2U submit failed after payment ${created.paymentId} was created: ${stripSecrets(e.message)}`);
    err.code = 'submit_failed';
    err.paymentId = created.paymentId;
    err.recipient = created.recipient;
    throw err;
  }
  try {
    await complete(created.paymentId, txid);
  } catch (e) {
    const err = new Error(`A2U complete failed for payment ${created.paymentId} (tx ${txid} was submitted): ${stripSecrets(e.message)}`);
    err.code = 'complete_failed';
    err.paymentId = created.paymentId;
    err.recipient = created.recipient;
    err.txid = txid;
    throw err;
  }
  return { paymentId: created.paymentId, recipient: created.recipient, txid, amount };
}

// ---- one-at-a-time mutex (Pi sequence-number safety) ----
let a2uQueue = Promise.resolve();
function withA2ULock(fn) {
  const run = a2uQueue.then(fn, fn);
  a2uQueue = run.catch(() => {}); // keep the chain alive after a failure
  return run;
}

module.exports = {
  MAX_PAYOUT_PI, NETWORK_PASSPHRASE, HORIZON_TESTNET_URL,
  stripSecrets, formatAmount, validatePayoutInput,
  createA2UPayment, completeA2UPayment, submitA2UTransaction, executeA2UPayout,
  withA2ULock,
};
