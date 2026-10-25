const express = require('express');
const c = require('../../controllers/legal.controller');
const validate = require('../../middlewares/validate.middleware');
const { limiter } = require('../../middlewares/rateLimit.middleware');
const v = require('../../validations/legal.validation');

// Mounted at /v1/public/legal. Published text only, always sanitised, cached for a minute.
const router = express.Router();
const readLimiter = limiter({ name: 'legal-read', windowMs: 60 * 1000, limit: 120, message: 'Too many requests. Please slow down.' });

router.get('/', readLimiter, c.publicList);
router.get('/:type', readLimiter, validate(v.publicOne), c.publicOne);
router.get('/:type/versions/:version', readLimiter, validate(v.publicVersion), c.publicVersion);

module.exports = router;
