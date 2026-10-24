const express = require('express');
const catchAsync = require('../../utils/catchAsync');
const { limiter } = require('../../middlewares/rateLimit.middleware');
const maintenance = require('../../services/maintenance.service');

const router = express.Router();

// GET /v1/public/maintenance-status : is a maintenance window active or coming up? No login, no ids, no internal notes.
// The apps poll this to show a notice before the window and to recover on their own after it.
const statusLimiter = limiter({ name: 'maint-status', windowMs: 60 * 1000, limit: 120, message: 'Too many requests. Please slow down.' });

router.get('/', statusLimiter, catchAsync(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { ...(await maintenance.publicStatus()), serverTime: new Date().toISOString() } });
}));

module.exports = router;
