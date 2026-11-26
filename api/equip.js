'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * POST /api/equip — equip / unequip an Ethereal as a machine core.
 * Body: { uid, username?, partId, equip: true|false }
 * Max 3 Ethereals equipped at a time. Abilities only apply while equipped.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (!body.uid) return sendJson(res, 400, { error: 'uid is required' });
  if (!(await store.requireLoad(res))) return;
  const result = store.equipEthereal(body.uid, body.username, { partId: body.partId, equip: body.equip });
  if (!(await store.requireSave(res))) return;
  if (result.error) return sendJson(res, 400, result);
  sendJson(res, 200, result);
};
