const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../../controllers/libraryWebsite.controller');
const validate = require('../../middlewares/validate.middleware');
const { websiteValidation } = require('../../validations');

const router = express.Router();

const limiter = rateLimit({
    windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
    message: { success: false, code: 429, message: 'Too many requests. Please slow down.' }
});

// GET /v1/public/tenant/resolve?host=gyan.dddesk.ai  (or Host / x-forwarded-host / x-tenant-slug)
router.get('/resolve', limiter, validate(websiteValidation.resolveQuery), ctrl.resolveTenant);

module.exports = router;
