'use strict';
const { sendJson, methodNotAllowed } = require('./_lib/http');
const store = require('./_lib/store');

/** GET /api/inventory?uid=... — your parts, machine, fragments, Ethereal Fate. */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const url = new URL(req.url, 'http://localhost');
  const uid = url.searchParams.get('uid');
  if (!uid) return sendJson(res, 400, { error: 'uid is required' });
  const u = store.getUser(uid);
  sendJson(res, 200, {
    user: store.publicUser(u),
    parts: u.parts.map(store.publicPart),
    machinePower: store.machinePower(u),
    utcDay: store.utcDay(),
  });
};
