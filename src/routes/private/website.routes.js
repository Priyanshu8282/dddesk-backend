const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../../controllers/libraryWebsite.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireOwner, requirePermission } = require('../../middlewares/access.middleware');
const { websiteValidation } = require('../../validations');

const router = express.Router();

const perLibrary = (req) => String(req.libraryId || 'anon');
const verifyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    keyGenerator: perLibrary, validate: { keyGeneratorIpFallback: false },
    message: { success: false, code: 429, message: 'Too many verification attempts. Please wait a few minutes.' }
});
const slugLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    keyGenerator: perLibrary, validate: { keyGeneratorIpFallback: false },
    message: { success: false, code: 429, message: 'Too many slug change attempts.' }
});

// Students never reach these routes
router.use(requireStaff);
const canManage = requirePermission('settings.manage', 'website.manage');

router.get('/settings', canManage, ctrl.getSettings);
router.put('/settings', canManage, validate(websiteValidation.updateSettings), ctrl.updateSettings);

// Custom domain (owner only)
router.get('/custom-domain', requireOwner, ctrl.getCustomDomain);
router.post('/custom-domain', requireOwner, validate(websiteValidation.customDomain), ctrl.requestCustomDomain);
router.post('/custom-domain/verify', requireOwner, verifyLimiter, ctrl.verifyCustomDomain);
router.delete('/custom-domain', requireOwner, ctrl.removeCustomDomain);

// Slug change (owner only, once per 30 days)
router.put('/slug', requireOwner, slugLimiter, validate(websiteValidation.changeSlug), ctrl.changeSlug);

module.exports = router;
