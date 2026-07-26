const PageVisit = require('./pageVisit.model');
const { heartbeat, getLiveCount } = require('./liveVisitors');

/**
 * POST /v1/public/visit
 * Record a unique page visit fingerprint.
 * Body: { fingerprint: string, vendorId?: string }
 */
exports.recordVisit = async (req, res) => {
    try {
        const { fingerprint, vendorId } = req.body;
        if (!fingerprint) return res.status(400).json({ success: false, message: 'fingerprint required' });

        await PageVisit.updateOne(
            { fingerprint, vendorId: vendorId || null },
            { $setOnInsert: { fingerprint, vendorId: vendorId || null } },
            { upsert: true }
        );

        res.json({ success: true });
    } catch (error) {
        // Duplicate key errors are fine — means dedup worked
        if (error.code === 11000) return res.json({ success: true });
        console.error('[VISIT_ERR]', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /v1/public/ping
 * Heartbeat from an active visitor. Refreshes their TTL in the live map.
 * Body: { token: string, vendorId?: string }
 */
exports.heartbeatPing = (req, res) => {
    const { token, vendorId } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'token required' });
    heartbeat(token, vendorId || null);
    res.json({ success: true });
};
