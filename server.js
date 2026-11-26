'use strict';
/**
 * Mech Destiny — local dev server (zero dependencies).
 * Serves public/ and routes /api/* to the same handlers Vercel runs as
 * serverless functions, so local behaviour mirrors production.
 *
 * Usage:  npm run dev   (or: node server.js)   -> http://localhost:3000
 * Env:    copy .env.example to .env first (or export vars). DATA_FILE is set
 *         here for local persistence; Vercel does not set it (see api/_lib/store.js).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dotenv dependency).
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
})();
if (!process.env.DATA_FILE) process.env.DATA_FILE = path.join(__dirname, 'data', 'store.json');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};

const apiHandlers = {
  '/api/status': require('./api/status'),
  '/api/me': require('./api/me'),
  '/api/checkin': require('./api/checkin'),
  '/api/inventory': require('./api/inventory'),
  '/api/merge': require('./api/merge'),
  '/api/battle': require('./api/battle'),
  '/api/forge': require('./api/forge'),
  '/api/equip': require('./api/equip'),
  '/api/draw': require('./api/draw'),
  '/api/leaderboard': require('./api/leaderboard'),
  '/api/pool': require('./api/pool'),
  '/api/shop': require('./api/shop'),
  '/api/payment-approve': require('./api/payment-approve'),
  '/api/payment-complete': require('./api/payment-complete'),
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const handler = apiHandlers[url.pathname];
      if (!handler) {
        res.statusCode = 404; res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'unknown api route' }));
      }
      // Vercel-style req/res: handlers use req.body (parsed) and res.statusCode/.end().
      // Our http helpers parse the body themselves when req.body is absent.
      return await handler(req, res);
    }
    let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) { res.statusCode = 403; return res.end('forbidden'); }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error(e);
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: e.message }));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mech Destiny dev server: http://localhost:${PORT}`);
  console.log(`Sandbox: ${process.env.PI_SANDBOX !== 'false'} | Server key set: ${!!process.env.PI_SERVER_API_KEY} | Mock auth: ${process.env.DEV_ALLOW_MOCK_AUTH === 'true'}`);
});
