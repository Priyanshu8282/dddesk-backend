const express = require('express');
const { limiter } = require('../../middlewares/rateLimit.middleware');
const svc = require('../../services/idCardVerify.service');

const router = express.Router();

// Scanning cards is cheap for a person; stop anyone walking through codes
const verifyLimiter = limiter({ name: 'id-verify', windowMs: 60 * 1000, limit: 30 });

// GET /v1/public/verify/student/:code  (the link printed as a QR on the student ID card)
router.get('/student/:code', verifyLimiter, async (req, res, next) => {
    try {
        const data = await svc.verify(req.params.code);
        res.set('Cache-Control', 'no-store');
        res.set('X-Robots-Tag', 'noindex');
        res.status(200).json({ success: true, data });
    } catch (e) { next(e); }
});

module.exports = router;
