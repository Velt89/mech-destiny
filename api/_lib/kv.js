'use strict';
/**
 * Mech Destiny — persistent shared store adapter (Vercel KV / Upstash Redis).
 *
 * The whole game state is ONE JSON document under a single key. That is the
 * simplest correct shape at this scale: every Vercel function instance reads
 * the same document, so a part granted on one instance is visible on the next
 * request no matter which instance serves it, and deploys no longer wipe
 * everything. Per-entity keys would be a later optimisation, not a correctness
 * fix.
 *
 * READ-MODIFY-WRITE RACE (known, accepted for this hackathon scaffold): each
 * request loads the document, mutates it in memory, then writes it back. Two
 * requests for the SAME user landing on different instances at the same instant
 * can both load the same version and the second write silently overwrites the
 * first (lost update). In practice requests for one user are sequential (one
 * browser, one tap at a time), and idempotency keys (mergeId / battleId /
 * paymentId) make replays safe. A production store would use per-entity keys
 * or transactions (e.g. Redis WATCH/MULTI) instead of one document.
 *
 * Detection (first match wins — REST backends keep priority):
 *   - Legacy Vercel KV: KV_REST_API_URL + KV_REST_API_TOKEN (auto-added when
 *     a KV store is attached to the project).
 *   - Current Vercel Marketplace Redis (Upstash REST): UPSTASH_REDIS_REST_URL +
 *     UPSTASH_REDIS_REST_TOKEN (Vercel KV is deprecated; a store created
 *     today will most likely be an Upstash one with these names).
 *   - Vercel Marketplace Redis (native protocol): REDIS_URL (a redis:// or
 *     rediss:// URL, auto-added when a Redis store is attached). The
 *     Marketplace Redis integration exposes ONLY this variable — no REST
 *     URL/token — so this backend speaks the native Redis protocol via the
 *     `redis` package (node-redis). `rediss://` enables TLS automatically.
 * If none of these is present, the app runs in-memory (local dev behaviour).
 *
 * FAIL CLOSED: when a store is configured but unreachable (bad token, network
 * error, 401/403), load/save THROW. Callers turn that into a 500 with a clear
 * message. Silently falling back to per-instance memory would reintroduce the
 * exact bug this module exists to fix (different instances, different data)
 * while looking like it works — so there is no silent fallback.
 *
 * REDIS_URL backend — connection lifecycle: one shared client per warm
 * function instance, created lazily on first use and reused across requests
 * (a fresh TCP+TLS handshake per request would be slow and flaky on
 * serverless). `reconnectStrategy: false` so a dropped connection surfaces
 * as an error instead of queueing commands forever; connect and command
 * calls are wrapped in a 5s timeout so a hung socket becomes a 500, not a
 * hung function. On any error the cached client is destroyed and dropped, so
 * the next request starts a fresh connection — but the current request still
 * throws (fail closed). The client's 'error' event has a no-op listener so a
 * connection failure cannot crash the process as an unhandled event; command
 * promises still reject with the real error.
 */

const STATE_KEY = 'mech-destiny:state:v1';
const CONNECT_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 5000;

function kvConfig() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return { kind: 'rest', url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN, source: 'KV_REST_API_URL' };
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return { kind: 'rest', url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, source: 'UPSTASH_REDIS_REST_URL' };
  }
  if (process.env.REDIS_URL) {
    return { kind: 'redis', url: process.env.REDIS_URL, source: 'REDIS_URL' };
  }
  return null;
}

function isKvConfigured() { return kvConfig() !== null; }
function storeMode() { return isKvConfigured() ? 'kv' : 'memory'; }

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---- REST backend (@vercel/kv) ----
let restClient = null;
function getRestClient() {
  if (restClient) return restClient;
  const cfg = kvConfig();
  if (!cfg || cfg.kind !== 'rest') throw new Error('KV store is not configured (no KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN)');
  // Lazy require + lazy createClient: importing @vercel/kv must never break
  // local dev runs that have no KV env vars at all.
  const { createClient } = require('@vercel/kv');
  restClient = createClient({ url: cfg.url, token: cfg.token });
  return restClient;
}

// ---- Native Redis backend (REDIS_URL, `redis` package) ----
let redisClient = null;
let redisConnectPromise = null;
function dropRedisClient() {
  const c = redisClient;
  redisClient = null;
  redisConnectPromise = null;
  if (c) { try { c.destroy(); } catch (_) { /* already closed */ } }
}
async function getRedisClient() {
  if (redisClient) {
    if (redisClient.isOpen) return redisClient;
    dropRedisClient(); // closed/broken — reconnect fresh below
  }
  if (!redisConnectPromise) {
    const cfg = kvConfig();
    if (!cfg || cfg.kind !== 'redis') throw new Error('Redis store is not configured (no REDIS_URL)');
    // Lazy require: importing `redis` must never break local dev runs that
    // have no store env vars at all.
    const { createClient } = require('redis');
    const c = createClient({
      url: cfg.url, // redis:// plain, rediss:// TLS (node-redis enables TLS for rediss)
      socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
    });
    // Without this, a connection failure is an unhandled 'error' event and
    // crashes the process. Command promises still reject with the real error.
    c.on('error', () => {});
    redisClient = c;
    redisConnectPromise = withTimeout(c.connect(), CONNECT_TIMEOUT_MS, 'Redis connect')
      .then(() => c)
      .catch((e) => { dropRedisClient(); throw e; });
  }
  return redisConnectPromise;
}

/** Load the whole state document. Returns the parsed object, or null when the key does not exist yet (fresh store). Throws on any store error (fail closed). */
async function loadState() {
  const cfg = kvConfig();
  if (!cfg) return null;
  let raw;
  if (cfg.kind === 'redis') {
    try {
      const c = await getRedisClient();
      raw = await withTimeout(c.get(STATE_KEY), COMMAND_TIMEOUT_MS, 'Redis GET');
    } catch (e) {
      dropRedisClient();
      throw new Error(`KV store unavailable on load: ${e && e.message ? e.message : e}`);
    }
  } else {
    try {
      raw = await getRestClient().get(STATE_KEY);
    } catch (e) {
      throw new Error(`KV store unavailable on load: ${e && e.message ? e.message : e}`);
    }
  }
  if (raw === null || raw === undefined) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`KV store returned a corrupt state document: ${e.message}`);
  }
}

/** Persist the whole state document (plain object, JSON-serialisable). Throws on any store error (fail closed). */
async function saveState(doc) {
  const cfg = kvConfig();
  if (!cfg) return;
  if (cfg.kind === 'redis') {
    try {
      const c = await getRedisClient();
      await withTimeout(c.set(STATE_KEY, JSON.stringify(doc)), COMMAND_TIMEOUT_MS, 'Redis SET');
    } catch (e) {
      dropRedisClient();
      throw new Error(`KV store unavailable on save: ${e && e.message ? e.message : e}`);
    }
    return;
  }
  try {
    await getRestClient().set(STATE_KEY, JSON.stringify(doc));
  } catch (e) {
    throw new Error(`KV store unavailable on save: ${e && e.message ? e.message : e}`);
  }
}

module.exports = { STATE_KEY, kvConfig, isKvConfigured, storeMode, loadState, saveState };
