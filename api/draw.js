'use strict';
const { sendJson, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * GET /api/draw?uid=... — draw odds, prices, and your Ethereal Fate pity counter.
 * Draws are NEVER granted by this route — only by /api/payment-complete after
 * a Pi payment completes server-side.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const url = new URL(req.url, 'http://localhost');
  const uid = url.searchParams.get('uid');
  if (!uid) return sendJson(res, 400, { error: 'uid is required' });
  if (!(await store.requireLoad(res))) return;
  const u = store.getUser(uid);
  if (!(await store.requireSave(res))) return; // getUser may have created the user
  sendJson(res, 200, {
    draws: store.DRAW_ODDS,
    etherealFate: {
      drawsWithoutEthereal: u.drawsWithoutEthereal,
      drawsToLegendaryPlus: Math.max(0, 11 - u.drawsWithoutEthereal),
      drawsToEthereal: Math.max(0, 31 - u.drawsWithoutEthereal),
      note: 'After 10 draws without an Ethereal, the next draw is guaranteed Legendary or better. After 30, the next is guaranteed Ethereal. The counter resets when an Ethereal drops.',
    },
    totalDraws: u.totalDraws,
    inventoryRoom: store.INVENTORY_CAP - u.parts.length,
    poolShare: store.POOL_SHARE,
  });
};
