const express = require('express');
const router = express.Router();
const reviewController = require('../../controllers/review.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireStudent, requirePermission, allow } = require('../../middlewares/access.middleware');
const { reviewLimiter } = require('../../middlewares/rateLimit.middleware');
const { reviewValidation: v } = require('../../validations');

// ── Student ─────────────────────────────────────────────────────────────────
// Submit or edit own review (public testimonial or internal feedback)
router.post('/', requireStudent, reviewLimiter, validate(v.submitReview), reviewController.submitReview);
// Own reviews only
router.get('/my', requireStudent, reviewController.getMyReview);

// ── Staff: moderation (static paths before /:id) ────────────────────────────
router.get('/stats', requireStaff, reviewController.getStats);
router.get('/', requireStaff, validate(v.queryReviews), reviewController.getReviews);
router.get('/:id', requireStaff, validate(v.idParam), reviewController.getReviewById);
router.patch('/:id/status', requireStaff, requirePermission('content.publish'), validate(v.updateStatus), reviewController.updateStatus);
router.post('/:id/reply', requireStaff, requirePermission('content.publish'), validate(v.replyReview), reviewController.replyToReview);

// Staff may remove any review of the library; a student only their own (enforced in the service)
router.delete('/:id', allow('admin', 'staff', 'superadmin', 'student'), validate(v.idParam), reviewController.deleteReview);

module.exports = router;
