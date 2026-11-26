'use strict';
const { sendJson, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/** GET /api/leaderboard?limit=20 — match ranking (weekly wins, tie-break Machine Power). */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const url = new URL(req.url, 'http://localhost');
  const limit = parseInt(url.searchParams.get('limit') || '20', 10) || 20;
  sendJson(res, 200, store.leaderboard(limit));
};
