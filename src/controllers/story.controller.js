const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const audit = require('../utils/audit');
const storyService = require('../services/story.service');
const { branchFilter, branchForCreate } = require('../utils/branchScope');

// ─── Staff ───────────────────────────────────────────────────────────────────
exports.createStory = catchAsync(async (req, res) => {
    req.body.branchId = await branchForCreate(req, req.libraryId, req.body.branchId);
    const story = await storyService.createStory(req.libraryId, req.body, req.file || null, req.user._id);
    audit(req, 'story.create', 'Story', story._id, { type: story.type });
    // Push is non-blocking; scheduled stories are pushed by publishDueStories()
    if (story.publishAt <= new Date()) storyService.publishNotification(story._id).catch(() => {});
    ApiResponse.created(res, story, 'Story created successfully');
});

exports.getStories = catchAsync(async (req, res) => {
    const result = await storyService.queryStories(req.libraryId, req.query, branchFilter(req));
    ApiResponse.ok(res, result.results, 'Stories retrieved successfully', {
        results: result.results, page: result.page, limit: result.limit,
        totalResults: result.totalResults, summary: result.summary
    });
});

exports.getAnalytics = catchAsync(async (req, res) => {
    const [summary, top] = await Promise.all([
        storyService.analytics(req.libraryId, branchFilter(req)),
        storyService.topStories(req.libraryId)
    ]);
    ApiResponse.ok(res, { summary, topStories: top }, 'Story analytics retrieved successfully');
});

exports.getStoryById = catchAsync(async (req, res) => {
    const story = await storyService.getStoryById(req.params.id, req.libraryId);
    if (!story) throw new ApiError(404, 'Story not found');
    ApiResponse.ok(res, story, 'Story retrieved successfully');
});

exports.updateStory = catchAsync(async (req, res) => {
    if (req.body.branchId !== undefined) req.body.branchId = await branchForCreate(req, req.libraryId, req.body.branchId);
    const story = await storyService.updateStory(req.params.id, req.libraryId, req.body, req.file || null);
    if (!story) throw new ApiError(404, 'Story not found');
    audit(req, 'story.update', 'Story', story._id);
    ApiResponse.ok(res, story, 'Story updated successfully');
});

exports.toggleStoryActive = catchAsync(async (req, res) => {
    const story = await storyService.toggleActive(req.params.id, req.libraryId);
    if (!story) throw new ApiError(404, 'Story not found');
    audit(req, 'story.toggle', 'Story', story._id, { isActive: story.isActive });
    ApiResponse.ok(res, story, `Story status updated to ${story.isActive ? 'Active' : 'Inactive'}`);
});

exports.deleteStory = catchAsync(async (req, res) => {
    const story = await storyService.deleteStory(req.params.id, req.libraryId);
    if (!story) throw new ApiError(404, 'Story not found');
    audit(req, 'story.delete', 'Story', story._id);
    ApiResponse.ok(res, null, 'Story deleted successfully');
});

// ─── Student ─────────────────────────────────────────────────────────────────
exports.getStoriesForStudent = catchAsync(async (req, res) => {
    const stories = await storyService.getActiveStudentStories(req.libraryId, req.user._id, req.user.branchId);
    ApiResponse.ok(res, stories, 'Active stories retrieved successfully');
});

exports.markStoryViewed = catchAsync(async (req, res) => {
    const data = await storyService.incrementViews(req.params.id, req.libraryId, req.user._id);
    ApiResponse.ok(res, data, 'Story marked as viewed');
});

exports.likeStory = catchAsync(async (req, res) => {
    const data = await storyService.toggleLike(req.params.id, req.libraryId, req.user._id);
    ApiResponse.ok(res, data, 'Story like toggled');
});

exports.replyToStory = catchAsync(async (req, res) => {
    const data = await storyService.addReply(req.params.id, req.libraryId, req.user._id, req.body.message);
    ApiResponse.ok(res, data, 'Reply sent');
});
