const express = require('express');
const ctrl = require('../../controllers/publicChat.controller');
const validate = require('../../middlewares/validate.middleware');
const { aiLimiter } = require('../../middlewares/rateLimit.middleware');
const v = require('../../validations/publicChat.validation');

const router = express.Router();

// Public marketing-site chatbot (no account/session needed). Reuses the same aiLimiter that protects the
// paid Gemini upstream for the authenticated assistant, since this endpoint costs the same upstream call.
router.post('/', aiLimiter, validate(v.chat), ctrl.chat);

module.exports = router;
