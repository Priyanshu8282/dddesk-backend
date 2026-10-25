const express = require('express');
const c = require('../../controllers/legal.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireSuperAdmin, blockImpersonation } = require('../../middlewares/access.middleware');
const { limiter, userKey } = require('../../middlewares/rateLimit.middleware');
const v = require('../../validations/legal.validation');

// Mounted at /super/legal. Super admin only; a support (impersonation) session may never change legal text.
const router = express.Router();
router.use(requireSuperAdmin);

const writeLimiter = limiter({ name: 'legal-write', windowMs: 60 * 60 * 1000, limit: 300, message: 'Too many changes. Try again later.', keyGenerator: userKey });
const publishLimiter = limiter({ name: 'legal-publish', windowMs: 60 * 60 * 1000, limit: 20, message: 'Too many publish attempts. Try again later.', keyGenerator: userKey });

router.get('/', c.list);
router.get('/:type/versions', validate(v.versionsList), c.versions);
router.get('/:type/compare', validate(v.compare), c.compare);
router.get('/:type/versions/:version', validate(v.getVersion), c.version);

router.post('/:type/draft', blockImpersonation, writeLimiter, validate(v.createDraft), c.createDraft);
router.put('/:type/draft', blockImpersonation, writeLimiter, validate(v.saveDraft), c.saveDraft);
router.delete('/:type/draft', blockImpersonation, writeLimiter, validate(v.versionsList), c.deleteDraft);
router.post('/:type/publish', blockImpersonation, publishLimiter, validate(v.publish), c.publish);
router.post('/:type/schedule/cancel', blockImpersonation, publishLimiter, validate(v.versionsList), c.cancelSchedule);
router.post('/:type/versions/:version/restore', blockImpersonation, writeLimiter, validate(v.restore), c.restore);

module.exports = router;
