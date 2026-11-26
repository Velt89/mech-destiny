'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/**
 * POST /api/merge — merge 2 identical parts into 1 part, one rarity up.
 * Body: { uid, username?, partIds: [id, id], mergeId }
 * mergeId is an idempotency key: replaying it is rejected. Ethereal cannot merge.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (!body.uid) return sendJson(res, 400, { error: 'uid is required' });
  const result = store.mergeParts(body.uid, body.username, { partIds: body.partIds, mergeId: body.mergeId });
  if (result.error) return sendJson(res, 400, result);
  sendJson(res, 200, result);
};
