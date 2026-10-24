const express = require('express');
const crypto = require('crypto');
const ApiError = require('../utils/ApiError');

const router = express.Router();

/**
 * HTTP trigger for scheduled jobs on serverless hosting (Vercel), where node-cron cannot run.
 * Vercel Cron calls GET with "Authorization: Bearer <CRON_SECRET>" (set CRON_SECRET in the project env).
 * Every job below is idempotent, so a retry or a second call is harmless.
 */
const authorize = (req, res, next) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) return next(new ApiError(503, 'Cron is not configured (CRON_SECRET is not set)'));
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(secret);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return next(new ApiError(401, 'Unauthorized'));
    next();
};

// While a maintenance window pauses jobs, answer 200 so the scheduler does not retry; the skip is logged
const paused = async (req, res, next) => {
    try {
        if (await require('../services/maintenance.service').cronsPaused()) {
            console.log(`[cron] skipped ${req.path}: maintenance window active (jobs paused)`);
            return res.json({ success: true, skipped: true, reason: 'maintenance' });
        }
        next();
    } catch (e) { next(e); }
};

router.get('/subscription-lifecycle', authorize, paused, async (req, res, next) => {
    try {
        const summary = await require('../services/subscriptionCron.service').runSubscriptionLifecycle();
        res.json({ success: true, data: summary });
    } catch (e) { next(e); }
});

// Everything that runs once a day: subscription lifecycle, membership expiry, fee overdue + reminders
router.get('/daily', authorize, paused, async (req, res, next) => {
    const out = {};
    const run = async (name, fn) => {
        try { out[name] = { ok: true, result: await fn() }; } catch (e) { out[name] = { ok: false, error: e.message }; }
    };
    const core = require('../services/cron.service');
    await run('subscriptionLifecycle', () => require('../services/subscriptionCron.service').runSubscriptionLifecycle());
    await run('membershipExpiry', async () => ({ expired: await core.expireMemberships(), resumed: await core.autoResumePaused() }));
    await run('feeJobs', () => require('../services/feeCron.service').runFeeJobs());
    res.json({ success: Object.values(out).every((r) => r.ok), data: out });
});

module.exports = router;
