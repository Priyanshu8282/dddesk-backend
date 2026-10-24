// Realtime entry point: `init(httpServer)` once at start-up (long-running host only) and the safe emit helpers.
// Business code calls e.g. `realtime.studentCreated({ libraryId, branchId })`: it never throws and does nothing
// beyond clearing the dashboard cache when sockets are not running (serverless, cron, tests).
const socket = require('./socket');
const emitters = require('./emitters');

const POLL_INTERVAL_MS = Number(process.env.DASHBOARD_POLL_INTERVAL_MS || 30000);

/** What the frontend needs to choose between sockets and polling. */
const info = () => ({
  socket: emitters.isEnabled(),
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  url: process.env.SOCKET_PUBLIC_URL || null,
  pollIntervalMs: POLL_INTERVAL_MS,
});

module.exports = { init: socket.init, close: socket.close, getIo: socket.getIo, isEnabled: emitters.isEnabled, info, ...emitters };
