'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * POST /api/forge — craft an Ethereal from 5 Blueprint Fragments + 1 Legendary part.
 * Body: { uid, username?, legendaryPartId }
 * Ethereal is never a free/battle drop — only the Forge and pay draws make one.
 * The crafted Ethereal gets a randomly rolled ability (Overdrive / Shield / Magnet).
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (!body.uid) return sendJson(res, 400, { error: 'uid is required' });
  const result = store.forgeCraft(body.uid, body.username, { legendaryPartId: body.legendaryPartId });
  if (result.error) return sendJson(res, 400, result);
  sendJson(res, 200, result);
};
