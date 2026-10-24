const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const http = require('http');
const app = require("./app");
const config = require("./config/config");
const connectDB = require('./config/database');

const server = http.createServer(app);

const port = config.port;

const { initCronJobs } = require('./services/cron.service');

connectDB().then(async () => {
    await require('./services/platformSettings.service').ensureFresh();
    require('./services/maintenance.service').logStartup();
    initCronJobs();

    // Live dashboards: socket.io runs only on this long-lived server (never in api/index.js on Vercel)
    require('./realtime').init(server);

    server.listen(port, "0.0.0.0", () => {
      console.log("Listening at PORT:", port);
    });
});