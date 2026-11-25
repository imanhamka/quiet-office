import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const HASHED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(?:js|css)$/;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

// Sent on every response. The built page loads its scripts, styles and data from this origin only.
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

const HEARTBEAT_MS = 15_000;
const MAX_CLIENT_BACKLOG = 4 * 1024 * 1024;

function plain(res, code, body, head) {
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

// tracker: { snapshot(): msg[], debugState(): object }.
// Returns { server, broadcast(msg), listen(port, host) -> Promise<port>, close() }.
export function createHttpServer({ tracker, webDir, log = console.log }) {
  const clients = new Set();
  let allowedHosts = new Set();
  let webRoot = path.resolve(webDir);
  let webRootReal = null;

  function sseWrite(res, chunk) {
    if (res.writableLength > MAX_CLIENT_BACKLOG) {
      res.destroy();
      clients.delete(res);
      return;
    }
    res.write(chunk);
  }

  function broadcast(msg) {
    if (clients.size === 0) return;
    const chunk = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) sseWrite(res, chunk);
  }

  const heartbeat = setInterval(() => {
    for (const res of clients) sseWrite(res, ':\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function handleEvents(req, res, head) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (head) return res.end();
    req.socket.setNoDelay(true);
    let initial = '';
    for (const msg of tracker.snapshot()) initial += `data: ${JSON.stringify(msg)}\n\n`;
    res.write(initial);
    clients.add(res);
    const drop = () => clients.delete(res);
    req.on('close', drop);
    res.on('error', drop);
  }

  async function serveStatic(pathname, res, head) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return plain(res, 404, 'not found', head);
    }
    if (decoded.includes('\0')) return plain(res, 404, 'not found', head);
    if (decoded === '/' || decoded === '') decoded = '/index.html';
    const target = path.resolve(webRoot, '.' + decoded);
    if (!target.startsWith(webRoot + path.sep)) return plain(res, 404, 'not found', head);
    let real;
    let st;
    try {
      if (!webRootReal) webRootReal = await fs.promises.realpath(webRoot);
      real = await fs.promises.realpath(target);
      st = await fs.promises.stat(real);
    } catch {
      return plain(res, 404, 'not found', head);
    }
    if (!real.startsWith(webRootReal + path.sep) || !st.isFile()) return plain(res, 404, 'not found', head);
    const type = CONTENT_TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': st.size,
      // Vite output with a content hash never changes; anything else (index.html, layout JSON,
      // sprites) must revalidate so a rebuild shows on the next reload.
      'Cache-Control': HASHED_ASSET.test(decoded) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (head) return res.end();
    const stream = fs.createReadStream(real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  const server = http.createServer((req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host || '')) return plain(res, 403, 'forbidden', req.method === 'HEAD');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return plain(res, 405, 'method not allowed', false);
      }
      const head = req.method === 'HEAD';
      const url = req.url || '/';
      const q = url.indexOf('?');
      const pathname = q === -1 ? url : url.slice(0, q);
      if (pathname === '/healthz') return plain(res, 200, 'ok', head);
      if (pathname === '/events') return handleEvents(req, res, head);
      if (pathname === '/state') {
        const body = JSON.stringify(tracker.debugState(), null, 2);
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        return res.end(head ? undefined : body);
      }
      serveStatic(pathname, res, head).catch((err) => {
        log(`[quiet-office] error static: ${err && err.message}`);
        if (!res.headersSent) plain(res, 500, 'error', head);
        else res.destroy();
      });
    } catch (err) {
      log(`[quiet-office] error request: ${err && err.message}`);
      if (!res.headersSent) plain(res, 500, 'error', false);
      else res.destroy();
    }
  });
  server.on('clientError', (_err, socket) => socket.destroy());

  function listen(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const actual = server.address().port;
        allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
        resolve(actual);
      });
    });
  }

  function close() {
    clearInterval(heartbeat);
    for (const res of clients) res.destroy();
    clients.clear();
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, broadcast, listen, close, clients };
}
