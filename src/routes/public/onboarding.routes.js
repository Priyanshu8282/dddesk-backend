const express = require('express');
const ctrl = require('../../controllers/onboarding.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireHuman } = require('../../middlewares/humanCheck.middleware');
const { limiter, otpVerifyLimiter } = require('../../middlewares/rateLimit.middleware');
const v = require('../../validations/onboarding.validation');

const router = express.Router();

const plansLimiter = limiter({ name: 'plans', windowMs: 60 * 1000, limit: 60, message: 'Too many requests. Please slow down.' });
const humanLimiter = limiter({ name: 'human', windowMs: 60 * 1000, limit: 30, message: 'Too many requests. Please slow down.' });
const completeLimiter = limiter({ name: 'reg-complete', windowMs: 60 * 60 * 1000, limit: 15, message: 'Too many registration attempts. Please try again later.' });
const draftLimiter = limiter({ name: 'reg-draft', windowMs: 10 * 60 * 1000, limit: 120, message: 'Too many requests. Please slow down.' });

// Public plan catalogue for the pricing page and the signup wizard
router.get('/plans', plansLimiter, ctrl.plans);

// Human verification (provider config, proof-of-work challenge, "does login need a challenge?")
router.get('/human-check/config', humanLimiter, ctrl.humanConfig);
router.get('/human-check/status', humanLimiter, validate(v.humanStatus), ctrl.humanStatus);
router.get('/human-challenge', humanLimiter, ctrl.humanChallenge);

// Signup wizard (all need the registration token from /register/verify-otp)
router.get('/register/draft', draftLimiter, ctrl.getDraft);
router.patch('/register/draft', draftLimiter, validate(v.patchDraft), ctrl.patchDraft);
router.post('/register/complete', completeLimiter, otpVerifyLimiter, requireHuman, validate(v.completeBody), ctrl.complete);

module.exports = router;
