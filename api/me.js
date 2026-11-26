'use strict';
const { sendJson, readJsonBody, methodNotAllowed } = require('./_lib/http');
const pi = require('./_lib/pi');

/**
 * POST /api/me — verify a Pi access token from Pi.authenticate().
 * Body: { accessToken }
 * The frontend user object is presentation-only; only this route's verified
 * uid is trusted as the user's identity. Fails closed: without a Server API
 * Key it returns verified:false (unless local-dev DEV_ALLOW_MOCK_AUTH=true).
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const body = await readJsonBody(req);
  if (body._parseError) return sendJson(res, 400, { error: 'invalid JSON body' });
  if (!body.accessToken) return sendJson(res, 400, { error: 'accessToken is required' });
  try {
    const result = await pi.verifyAccessToken(body.accessToken);
    sendJson(res, result.verified ? 200 : 401, result);
  } catch (e) {
    sendJson(res, 502, { verified: false, error: `Pi Platform API error: ${e.message}` });
  }
};
