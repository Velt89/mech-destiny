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
 * Detection: KV is active only when BOTH a URL and a token are present.
 *   - Legacy Vercel KV: KV_REST_API_URL + KV_REST_API_TOKEN (auto-added when
 *     a KV store is attached to the project).
 *   - Current Vercel Marketplace Redis (Upstash): UPSTASH_REDIS_REST_URL +
 *     UPSTASH_REDIS_REST_TOKEN (Vercel KV is deprecated; a store created
 *     today will most likely be an Upstash one with these names).
 * If neither pair is present, the app runs in-memory (local dev behaviour).
 *
 * FAIL CLOSED: when KV is configured but unreachable (bad token, network
 * error, 401/403), load/save THROW. Callers turn that into a 500 with a clear
 * message. Silently falling back to per-instance memory would reintroduce the
 * exact bug this module exists to fix (different instances, different data)
 * while looking like it works — so there is no silent fallback.
 */

const STATE_KEY = 'mech-destiny:state:v1';

function kvConfig() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN, source: 'KV_REST_API_URL' };
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, source: 'UPSTASH_REDIS_REST_URL' };
  }
  return null;
}

function isKvConfigured() { return kvConfig() !== null; }
function storeMode() { return isKvConfigured() ? 'kv' : 'memory'; }

let client = null;
function getClient() {
  if (client) return client;
  const cfg = kvConfig();
  if (!cfg) throw new Error('KV store is not configured (no KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN)');
  // Lazy require + lazy createClient: importing @vercel/kv must never break
  // local dev runs that have no KV env vars at all.
  const { createClient } = require('@vercel/kv');
  client = createClient({ url: cfg.url, token: cfg.token });
  return client;
}

/** Load the whole state document. Returns the parsed object, or null when the key does not exist yet (fresh store). Throws on any KV error (fail closed). */
async function loadState() {
  if (!isKvConfigured()) return null;
  let raw;
  try {
    raw = await getClient().get(STATE_KEY);
  } catch (e) {
    throw new Error(`KV store unavailable on load: ${e && e.message ? e.message : e}`);
  }
  if (raw === null || raw === undefined) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`KV store returned a corrupt state document: ${e.message}`);
  }
}

/** Persist the whole state document (plain object, JSON-serialisable). Throws on any KV error (fail closed). */
async function saveState(doc) {
  if (!isKvConfigured()) return;
  try {
    await getClient().set(STATE_KEY, JSON.stringify(doc));
  } catch (e) {
    throw new Error(`KV store unavailable on save: ${e && e.message ? e.message : e}`);
  }
}

module.exports = { STATE_KEY, kvConfig, isKvConfigured, storeMode, loadState, saveState };
