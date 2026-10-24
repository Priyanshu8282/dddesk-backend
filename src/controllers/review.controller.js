const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const audit = require('../utils/audit');
const reviewService = require('../services/review.service');
const Library = require('../models/library.model');

// Student submits / edits own review (route is student-only)
exports.submitReview = catchAsync(async (req, res) => {
    const review = await reviewService.submitReview(req.user, req.libraryId, req.body);
    ApiResponse.created(res, review, 'Review submitted successfully and sent for moderation');
});

exports.getReviews = catchAsync(async (req, res) => {
    const result = await reviewService.listReviews(req.libraryId, req.query || {});
    ApiResponse.ok(res, result.data, 'Reviews retrieved successfully', {
        total: result.total, page: result.page, totalPages: result.totalPages, limit: result.limit
    });
});

// Student: own reviews only
exports.getMyReview = catchAsync(async (req, res) => {
    const reviews = await reviewService.getMyReview(req.user._id, req.libraryId);
    ApiResponse.ok(res, reviews, 'My reviews retrieved successfully');
});

exports.getReviewById = catchAsync(async (req, res) => {
    const review = await reviewService.getReviewById(req.params.id, req.libraryId);
    ApiResponse.ok(res, review, 'Review details retrieved successfully');
});

exports.updateStatus = catchAsync(async (req, res) => {
    const updated = await reviewService.updateReviewStatus(req.params.id, req.libraryId, req.body.status, req.body.isFeatured, req.user);
    audit(req, 'review.moderate', 'Review', req.params.id, { status: req.body.status, isFeatured: req.body.isFeatured });
    ApiResponse.ok(res, updated, 'Review updated successfully');
});

exports.replyToReview = catchAsync(async (req, res) => {
    const updated = await reviewService.replyToReview(req.params.id, req.libraryId, req.body.reply, req.user);
    audit(req, 'review.reply', 'Review', req.params.id);
    ApiResponse.ok(res, updated, 'Reply posted successfully');
});

exports.deleteReview = catchAsync(async (req, res) => {
    await reviewService.deleteReview(req.params.id, req.libraryId, req.user);
    audit(req, 'review.delete', 'Review', req.params.id);
    ApiResponse.ok(res, null, 'Review deleted successfully');
});

exports.getStats = catchAsync(async (req, res) => {
    const stats = await reviewService.getReviewStats(req.libraryId);
    ApiResponse.ok(res, stats, 'Review statistics retrieved successfully');
});

