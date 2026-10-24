// Socket.io server: authenticated, origin-checked, rate limited. Rooms are chosen by the server (see rooms.js).
// Only works on a long-running Node host. On Vercel/serverless it is never started (see index.js).
const { Server } = require('socket.io');
const { isAllowedOrigin } = require('../config/cors');
const sessionService = require('../services/session.service');
const { authenticate } = require('./auth');
const rooms = require('./rooms');
const limits = require('./limits');
const emitters = require('./emitters');

const SESSION_CHECK_MS = Number(process.env.SOCKET_SESSION_CHECK_MS || 60 * 1000);
const MAX_MESSAGE_BYTES = 8 * 1024;

let io = null;

const originAllowed = (origin) => !origin || isAllowedOrigin(origin);

/** Optional multi-instance support: only when REDIS_URL is set AND the adapter packages are installed. */
const attachRedisAdapter = (server) => {
  if (!process.env.REDIS_URL) return false;
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const { createClient } = require('redis');
    const pub = createClient({ url: process.env.REDIS_URL });
    const sub = pub.duplicate();
    pub.on('error', (e) => console.error('[realtime] redis error:', e.message));
    sub.on('error', (e) => console.error('[realtime] redis error:', e.message));
    Promise.all([pub.connect(), sub.connect()])
      .then(() => { server.adapter(createAdapter(pub, sub)); console.log('[realtime] redis adapter on'); })
      .catch((e) => console.error('[realtime] redis adapter failed, running single-instance:', e.message));
    return true;
  } catch (e) {
    console.warn('[realtime] REDIS_URL is set but @socket.io/redis-adapter / redis are not installed: running single-instance. npm i @socket.io/redis-adapter redis');
    return false;
  }
};

const init = (httpServer) => {
  if (io) return io;
  if (process.env.VERCEL || String(process.env.REALTIME_ENABLED).toLowerCase() === 'false') return null;

  io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    pingInterval: 25000,
    pingTimeout: 20000,
    perMessageDeflate: false,
    transports: ['websocket', 'polling'],
    // Browsers from non-listed origins never get a socket. Non-browser clients (no Origin) still need a valid token.
    allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin)),
    cors: { origin: (origin, cb) => cb(null, originAllowed(origin)), credentials: true, methods: ['GET', 'POST'] },
  });
  attachRedisAdapter(io);

  // 1) connection flood guard
  io.use((socket, next) => {
    const ip = limits.clientIp(socket);
    socket.data.ip = ip;
    if (!limits.allowConnection(ip)) return next(new Error('rate_limited'));
    next();
  });

  // 2) authentication (same checks as the HTTP API)
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      const info = await authenticate(token, socket.data.ip);
      if (!limits.claimUserSlot(info.userId)) return next(new Error('too_many_connections'));
      socket.data.info = info;
      next();
    } catch (e) {
      next(new Error(['unauthorized', 'forbidden', 'library_inactive'].includes(e.message) ? e.message : 'unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const info = socket.data.info;
    const allowed = limits.eventLimiter();
    let closed = false;
    const timers = [];

    const finish = () => {
      if (closed) return;
      closed = true;
      timers.forEach(clearTimeout);
      timers.forEach(clearInterval);
      limits.releaseUserSlot(info.userId);
    };
    socket.on('disconnect', finish);

    // The server picks the rooms; the client cannot join anything by itself
    socket.join(rooms.roomsFor(info.ctx));

    // Clients are not expected to send anything: drop flooders
    socket.use((packet, next) => {
      if (!allowed()) { socket.disconnect(true); return; }
      next(new Error('not_supported'));
    });

    // End the socket exactly when its access token expires (the client reconnects with a fresh token)
    if (info.exp) {
      const ms = Math.max(info.exp - Date.now(), 0);
      const t = setTimeout(() => { socket.emit('auth:expired', {}); socket.disconnect(true); }, ms);
      t.unref && t.unref();
      timers.push(t);
    }
    // Revoked sessions (logout, password reset, user disabled) end the socket within a minute
    const poll = setInterval(async () => {
      try {
        if (!(await sessionService.isActive(info.sid, info.userId))) {
          socket.emit('auth:revoked', {});
          socket.disconnect(true);
        }
      } catch (_) { /* transient database error: keep the socket, check again next tick */ }
    }, SESSION_CHECK_MS);
    poll.unref && poll.unref();
    timers.push(poll);

    // Maintenance blocks this user: tell the client to read the public status
    if (info.blocked) socket.emit('maintenance:changed', { refresh: true });
  });

  emitters.setIo(io);
  console.log('[realtime] socket.io ready on /socket.io');
  return io;
};

const close = async () => {
  if (!io) return;
  const instance = io;
  io = null;
  emitters.setIo(null);
  await new Promise((resolve) => instance.close(resolve));
};

const getIo = () => io;

module.exports = { init, close, getIo, originAllowed };
