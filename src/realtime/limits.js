// Small in-memory limiters for the socket server (per process).
const WINDOW_MS = 60 * 1000;
const MAX_CONN_PER_IP_PER_MIN = Number(process.env.SOCKET_MAX_CONN_PER_IP_MIN || 20);
const MAX_SOCKETS_PER_USER = Number(process.env.SOCKET_MAX_PER_USER || 10);
const EVENT_WINDOW_MS = 10 * 1000;
const MAX_EVENTS_PER_WINDOW = 20;

const ipHits = new Map();   // ip -> { n, resetAt }
const userSockets = new Map(); // userId -> count

/** Client IP behind one proxy: the last X-Forwarded-For hop is the one the proxy appended. */
const clientIp = (socket) => {
  const xff = socket.request && socket.request.headers && socket.request.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return socket.handshake.address || 'unknown';
};

/** true when this IP may open another connection now */
const allowConnection = (ip, now = Date.now()) => {
  if (ipHits.size > 5000) for (const [k, v] of ipHits) if (v.resetAt <= now) ipHits.delete(k);
  const hit = ipHits.get(ip);
  if (!hit || hit.resetAt <= now) { ipHits.set(ip, { n: 1, resetAt: now + WINDOW_MS }); return true; }
  hit.n += 1;
  return hit.n <= MAX_CONN_PER_IP_PER_MIN;
};

const claimUserSlot = (userId) => {
  const n = userSockets.get(userId) || 0;
  if (n >= MAX_SOCKETS_PER_USER) return false;
  userSockets.set(userId, n + 1);
  return true;
};
const releaseUserSlot = (userId) => {
  const n = (userSockets.get(userId) || 1) - 1;
  if (n <= 0) userSockets.delete(userId); else userSockets.set(userId, n);
};

/** Per-socket incoming event limiter: returns a function that is true while the socket is within its allowance. */
const eventLimiter = () => {
  let n = 0, resetAt = Date.now() + EVENT_WINDOW_MS;
  return () => {
    const now = Date.now();
    if (now >= resetAt) { n = 0; resetAt = now + EVENT_WINDOW_MS; }
    n += 1;
    return n <= MAX_EVENTS_PER_WINDOW;
  };
};

module.exports = { clientIp, allowConnection, claimUserSlot, releaseUserSlot, eventLimiter, MAX_EVENTS_PER_WINDOW, _reset: () => { ipHits.clear(); userSockets.clear(); } };
