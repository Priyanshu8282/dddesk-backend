const express = require('express');
const authRoutes = require('./auth.routes');
const websiteRoutes = require('./website.routes');
const tenantRoutes = require('./tenant.routes');

const router = express.Router();

// Mount public auth & registration directly at /v1/public (e.g. /v1/public/login)
router.use('/', authRoutes);

// Mount public website dynamic profile routes (e.g. /v1/public/website/:slug)
router.use('/website', websiteRoutes);

// Tenant resolution from host (e.g. /v1/public/tenant/resolve?host=gyan.dddesk.ai)
router.use('/tenant', tenantRoutes);

// Health check: /v1/public/health
router.use('/health', require('./health.routes'));

// Platform name, logo, favicon, maintenance + registration state: /v1/public/branding
router.use('/branding', require('./branding.routes'));

// Country / state / city lists for address forms: /v1/public/locations/{countries,states,cities}
router.use('/locations', require('./location.routes'));

// Razorpay webhook (signature-verified, no JWT): /v1/public/razorpay/webhook
router.use('/razorpay', require('./razorpay.routes'));

module.exports = router;
