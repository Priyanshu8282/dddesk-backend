const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const audit = require('../utils/audit');
const noticeService = require('../services/notice.service');
const { branchFilter, branchForCreate } = require('../utils/branchScope');

// ─── Staff ───────────────────────────────────────────────────────────────────
exports.createNotice = catchAsync(async (req, res) => {
    req.body.branchId = await branchForCreate(req, req.libraryId, req.body.branchId);
    const notice = await noticeService.createNotice(req.libraryId, req.body, req.file || null, req.user._id);
    audit(req, 'notice.create', 'Notice', notice._id, { type: notice.type, sendTo: notice.sendTo });
    // Delivery is non-blocking; scheduled notices are delivered by publishDueNotices()
    noticeService.deliverOnce(notice._id).catch(() => {});
    ApiResponse.created(res, notice, 'Notice created successfully');
});

exports.getNotices = catchAsync(async (req, res) => {
    const result = await noticeService.queryNotices(req.libraryId, req.query, branchFilter(req));
    ApiResponse.ok(res, result.results, 'Notices retrieved successfully', {
        results: result.results, page: result.page, limit: result.limit,
        totalResults: result.totalResults, summary: result.summary
    });
});

exports.getNoticeById = catchAsync(async (req, res) => {
    const notice = await noticeService.getNoticeById(req.params.id, req.libraryId);
    if (!notice) throw new ApiError(404, 'Notice not found');
    ApiResponse.ok(res, notice, 'Notice retrieved successfully');
});

exports.updateNotice = catchAsync(async (req, res) => {
    if (req.body.branchId !== undefined) req.body.branchId = await branchForCreate(req, req.libraryId, req.body.branchId);
    const notice = await noticeService.updateNotice(req.params.id, req.libraryId, req.body, req.file || null);
    if (!notice) throw new ApiError(404, 'Notice not found');
    audit(req, 'notice.update', 'Notice', notice._id);
    ApiResponse.ok(res, notice, 'Notice updated successfully');
});

exports.toggleNoticeActive = catchAsync(async (req, res) => {
    const current = await noticeService.getNoticeById(req.params.id, req.libraryId);
    if (!current) throw new ApiError(404, 'Notice not found');
    const notice = await noticeService.setPublished(req.params.id, req.libraryId, !current.isActive);
    audit(req, 'notice.toggle', 'Notice', notice._id, { isActive: notice.isActive });
    ApiResponse.ok(res, notice, `Notice status updated to ${notice.isActive ? 'Active' : 'Inactive'}`);
});

const publishHandler = (published) => catchAsync(async (req, res) => {
    const notice = await noticeService.setPublished(req.params.id, req.libraryId, published);
    if (!notice) throw new ApiError(404, 'Notice not found');
    audit(req, published ? 'notice.publish' : 'notice.unpublish', 'Notice', notice._id);
    ApiResponse.ok(res, notice, published ? 'Notice published' : 'Notice unpublished');
});
exports.publishNotice = publishHandler(true);
exports.unpublishNotice = publishHandler(false);

exports.deleteNotice = catchAsync(async (req, res) => {
    const notice = await noticeService.deleteNotice(req.params.id, req.libraryId);
    if (!notice) throw new ApiError(404, 'Notice not found');
    audit(req, 'notice.delete', 'Notice', notice._id);
    ApiResponse.ok(res, null, 'Notice deleted successfully');
});

// ─── Student ─────────────────────────────────────────────────────────────────
exports.getNoticesForStudent = catchAsync(async (req, res) => {
    const notices = await noticeService.getActiveStudentNotices(req.user);
    ApiResponse.ok(res, notices, 'Student notices retrieved successfully');
});

exports.markNoticeViewed = catchAsync(async (req, res) => {
    const data = await noticeService.incrementViews(req.params.id, req.user);
    ApiResponse.ok(res, data, 'Notice marked as viewed');
});
