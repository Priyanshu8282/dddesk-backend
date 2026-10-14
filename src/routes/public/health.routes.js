const express = require('express');
const mongoose = require('mongoose');
const pkg = require('../../../package.json');

const router = express.Router();

// GET /v1/public/health - liveness/readiness for load balancers. Exposes only coarse status, no internals.
router.get('/', (req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({
        status: dbUp ? 'ok' : 'degraded',
        db: dbUp ? 'up' : 'down',
        uptimeSeconds: Math.floor(process.uptime()),
        version: pkg.version,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
