const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const aiController = require('../../controllers/ai.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireFeature } = require('../../middlewares/entitlement.middleware');
const { requireStaff, requirePermission } = require('../../middlewares/access.middleware');
const { aiValidation } = require('../../validations');

const perUser = (req) => `${req.libraryId || 'anon'}:${req.user?._id || ''}`;
const limiter = (max, windowMs, message) => rateLimit({
    windowMs, max, standardHeaders: true, legacyHeaders: false, keyGenerator: perUser, validate: { keyGeneratorIpFallback: false },
    message: { success: false, code: 429, message }
});
const queryLimiter = limiter(20, 60 * 1000, 'Too many assistant requests. Please wait a minute.');
const actionLimiter = limiter(10, 60 * 1000, 'Too many confirmations. Please wait a minute.');

// Students never reach the assistant; staff need reports.view or ai.use (owners and superadmin pass)
router.use(requireStaff, requirePermission('reports.view', 'ai.use'), requireFeature('ai'));

router.post('/query', queryLimiter, validate(aiValidation.queryAi), aiController.queryAssistant);
router.get('/insights', queryLimiter, validate(aiValidation.tenantQuery), aiController.getInsights);
router.get('/quick-prompts', aiController.getQuickPrompts);
router.get('/history', validate(aiValidation.historyQuery), aiController.getChatHistory);
router.delete('/history', validate(aiValidation.tenantQuery), aiController.clearChatHistory);

// Proposed actions run only after explicit confirmation; staff additionally need fees.collect to send fee reminders
router.post('/confirm', actionLimiter, requirePermission('fees.collect'), validate(aiValidation.confirmAction), aiController.confirmAction);
router.post('/cancel', actionLimiter, validate(aiValidation.confirmAction), aiController.cancelAction);

module.exports = router;
