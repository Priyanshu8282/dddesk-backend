const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const http = require('http');
const mongoose = require('mongoose');
const app = require("./app");
const config = require("./config/config");
const connectDB = require('./config/database');

const server = http.createServer(app);

const port = config.port;

const { initCronJobs } = require('./services/cron.service');

// Graceful shutdown: stop taking new connections, let running requests finish, close sockets and the database, then exit.
// The process manager (PM2, Docker, systemd) restarts the process. A hard timeout makes sure it can never hang.
let shuttingDown = false;
const shutdown = (reason, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[server] shutting down: ${reason}`);
    const force = setTimeout(() => { console.error('[server] forced exit after timeout'); process.exit(code || 1); }, 15000);
    force.unref();
    try { require('./realtime').close(); } catch (_) { /* realtime was not started */ }
    server.close(async () => {
        try { await mongoose.disconnect(); } catch (_) { /* already closed */ }
        process.exit(code);
    });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// A bug in one request must not leave the process in an unknown state: log it, finish in-flight work, restart cleanly.
process.on('uncaughtException', (err) => { console.error('[server] uncaughtException:', err); shutdown('uncaughtException', 1); });
process.on('unhandledRejection', (reason) => { console.error('[server] unhandledRejection:', reason); shutdown('unhandledRejection', 1); });

connectDB().then(async () => {
    // connectDB only logs a failure. Serving requests without a database would hang every call, so stop and let the
    // process manager restart us (it keeps retrying until the database is reachable).
    if (mongoose.connection.readyState !== 1) {
        console.error('[server] database is not connected, exiting');
        process.exit(1);
    }

    await require('./services/platformSettings.service').ensureFresh();
    require('./services/maintenance.service').logStartup();
    initCronJobs();

    // Live dashboards: socket.io runs only on this long-lived server (never in api/index.js on Vercel)
    require('./realtime').init(server);

    // Keep-alive above the usual load balancer idle timeout (60 s), so a connection is not cut mid-request
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    server.requestTimeout = 120000;

    server.listen(port, "0.0.0.0", () => {
      console.log("Listening at PORT:", port);
    });
}).catch((err) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
});
