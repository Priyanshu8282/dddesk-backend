const express = require('express');
const authRoutes = require('./auth.routes');
const websiteRoutes = require('./website.routes');

const router = express.Router();

// Onboarding (plans, human check, signup wizard): /v1/public/plans, /human-check/*, /register/draft, /register/complete
router.use('/', require('./onboarding.routes'));

// Mount public auth & registration directly at /v1/public (e.g. /v1/public/login)
router.use('/', authRoutes);

// Mount public website dynamic profile routes (e.g. /v1/public/website/:libraryId)
router.use('/website', websiteRoutes);

// Privacy / terms / refund text managed by the super admin: /v1/public/legal[/:type[/versions/:n]]
router.use('/legal', require('./legal.routes'));

// Health check: /v1/public/health
router.use('/health', require('./health.routes'));

// Maintenance window state (active / upcoming / off): /v1/public/maintenance-status
router.use('/maintenance-status', require('./maintenance.routes'));

// Platform name, logo, favicon, maintenance + registration state: /v1/public/branding
router.use('/branding', require('./branding.routes'));

// Country / state / city lists for address forms: /v1/public/locations/{countries,states,cities}
router.use('/locations', require('./location.routes'));

// Razorpay webhook (signature-verified, no JWT): /v1/public/razorpay/webhook
router.use('/razorpay', require('./razorpay.routes'));

module.exports = router;
