'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const C = require('./config');
const { Store } = require('./store');
const { Exchange } = require('./exchange');
const { Game, GameError } = require('./game');
const { Auth } = require('./auth');
const podium = require('./podium');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Простий обмежувач частоти (на ключ: IP або гравець). */
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      hits.set(key, arr);
      return false;
    }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}

function createApp({ dataDir = C.DATA_DIR } = {}) {
  const store = new Store(dataDir);
  const exchange = new Exchange(dataDir);
  const game = new Game(store, exchange);
  const auth = new Auth(store, game);

  const authLimit = makeLimiter(20, 60_000);   // входи/реєстрації з одного IP
  const actionLimit = makeLimiter(120, 10_000); // дії одного гравця

  // ---------- SSE: розсилка курсу ----------
  const streams = new Set();
  exchange.onTick((ev) => {
    const line = `data: ${JSON.stringify({ t: ev.ts, rate: ev.rate, prev: ev.prev })}\n\n`;
    for (const res of streams) res.write(line);
  });
  const keepAlive = setInterval(() => {
    for (const res of streams) res.write(': ka\n\n');
  }, 15_000);

  // ---------- HTTP-допоміжні ----------
  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 16 * 1024) {
          reject(new GameError('bad_request', 413));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' ? v : {});
        } catch (_) {
          reject(new GameError('bad_request'));
        }
      });
      req.on('error', reject);
    });
  }

  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
  }

  function requirePlayer(req) {
    const id = auth.verifyToken(bearer(req));
    if (!id) throw new GameError('unauthorized', 401);
    if (!actionLimit(id)) throw new GameError('too_many_requests', 429);
    return id;
  }

  const sid = (req) => req.headers['x-session'];

  // ---------- маршрути ----------
  async function route(req, res, url) {
    const { pathname } = url;
    const m = req.method;

    // публічні
    if (m === 'GET' && pathname === '/api/config') {
      return send(res, 200, {
        models: Object.values(C.MODELS),
        farmSize: C.FARM_SIZE,
        farmCols: C.FARM_COLS,
        sellRatioPercent: C.SELL_RATIO_PERCENT,
        rateMin: C.RATE_MIN,
        rateMax: C.RATE_MAX,
        rateTickMs: C.RATE_TICK_MS,
        heartbeatMs: C.HEARTBEAT_MS,
        maxGapMs: C.MAX_GAP_MS,
        nickMin: 3,
        nickMax: 20,
        nickCooldownMs: C.NICK_COOLDOWN_MS,
        passwordMin: C.PASSWORD_MIN,
      });
    }
    if (m === 'GET' && pathname === '/api/rate') {
      const cur = exchange.current();
      return send(res, 200, { t: cur.ts, rate: cur.rate, prev: cur.prev });
    }
    if (m === 'GET' && pathname === '/api/rate/history') {
      const range = url.searchParams.get('range') === '24h' ? '24h' : '1h';
      return send(res, 200, { range, points: exchange.history(range) });
    }
    if (m === 'GET' && pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const cur = exchange.current();
      res.write(`data: ${JSON.stringify({ t: cur.ts, rate: cur.rate, prev: cur.prev })}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (m === 'GET' && pathname === '/api/podium') {
      const id = auth.verifyToken(bearer(req));
      const cur = exchange.current();
      return send(res, 200, podium.view(store.db, cur.rate, cur.ts, id));
    }
    const prof = pathname.match(/^\/api\/profile\/(P-[A-Z0-9]{8})$/);
    if (m === 'GET' && prof) return send(res, 200, game.publicProfile(prof[1]));

    // авторизація
    if (m === 'POST' && (pathname === '/api/auth/register' || pathname === '/api/auth/login')) {
      if (!authLimit(req.socket.remoteAddress)) throw new GameError('too_many_requests', 429);
      const b = await readBody(req);
      const out = pathname.endsWith('register')
        ? await auth.register(b.email, b.password)
        : await auth.login(b.email, b.password);
      return send(res, 200, out);
    }
    if (m === 'POST' && pathname === '/api/auth/logout') {
      const t = bearer(req);
      if (t) auth.logout(t);
      return send(res, 200, { ok: true });
    }

    // захищені
    if (pathname.startsWith('/api/')) {
      const id = requirePlayer(req);
      const s = sid(req);

      if (m === 'POST' && pathname === '/api/session/start') return send(res, 200, game.startSession(id));
      if (m === 'POST' && pathname === '/api/heartbeat') return send(res, 200, game.heartbeat(id, s));

      if (m === 'POST') {
        const b = await readBody(req);
        switch (pathname) {
          case '/api/mining': return send(res, 200, game.setMining(id, s, b.enabled));
          case '/api/shop/buy': return send(res, 200, game.buy(id, s, b));
          case '/api/shop/sell': return send(res, 200, game.sellCard(id, s, b));
          case '/api/farm/install': return send(res, 200, game.install(id, s, b));
          case '/api/farm/uninstall': return send(res, 200, game.uninstall(id, s, b));
          case '/api/farm/move': return send(res, 200, game.move(id, s, b));
          case '/api/exchange/sell': return send(res, 200, game.sellCryp(id, s, b));
          case '/api/profile/nickname': return send(res, 200, game.setNickname(id, s, b.nickname));
          default: break;
        }
      }
    }
    throw new GameError('not_found', 404);
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await route(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
      else send(res, 405, 'method not allowed');
    } catch (e) {
      if (e instanceof GameError) return send(res, e.status, { error: e.code });
      console.error(e);
      send(res, 500, { error: 'server_error' });
    }
  });

  function start(port = C.PORT) {
    exchange.start();
    return new Promise((resolve) => server.listen(port, () => resolve(server)));
  }

  function stop() {
    clearInterval(keepAlive);
    for (const res of streams) res.end();
    exchange.stop();
    store.flush();
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, store, exchange, game, auth, start, stop };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  app.start().then(() => console.log(`CRYP Mining: http://localhost:${C.PORT}`));
  const shutdown = () => app.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
