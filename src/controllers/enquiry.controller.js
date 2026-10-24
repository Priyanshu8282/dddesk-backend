const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const audit = require('../utils/audit');
const svc = require('../services/enquiry.service');
const { enquiryLimiter } = require('../middlewares/rateLimit.middleware');
const { branchFilter, branchForCreate, resolveBranch } = require('../utils/branchScope');

// Public website submission (no auth). Library comes from libraryId and must be active.
const submitPublic = catchAsync(async (req, res) => {
  // Honeypot: bots fill hidden fields. Pretend success, store nothing.
  if (req.body.hp) {
    return ApiResponse.created(res, null, 'Enquiry submitted successfully');
  }
  const lib = await svc.resolvePublicLibrary({ libraryId: req.body.libraryId });
  const branchId = await resolveBranch(lib._id, req.body.branchId);
  const { enquiry, duplicate } = await svc.createEnquiry(lib._id, req.body, { source: 'website', ip: req.ip, branchId });
  if (!duplicate) svc.notifyOwner(lib._id, enquiry);
  ApiResponse.created(res, { id: enquiry._id }, 'Enquiry submitted successfully. The library will contact you soon.');
});

// Staff adds an enquiry (walk-in / phone / referral); library is always the staff member's own
const createStaff = catchAsync(async (req, res) => {
  const branchId = await branchForCreate(req, req.libraryId, req.body.branchId);
  const { enquiry, duplicate } = await svc.createEnquiry(req.libraryId, req.body, {
    source: req.body.source || 'walk-in', createdBy: req.user._id, ip: req.ip, branchId
  });
  if (duplicate) throw new ApiError(409, 'An enquiry from this mobile number was already recorded recently');
  ApiResponse.created(res, enquiry, 'Enquiry created successfully');
});

// Exported for the public route (/v1/public/website/enquiry) and the private POST /enquiries.
// Public requests are rate limited here so the route owner does not need to wire it.
exports.createEnquiry = (req, res, next) => {
  if (req.user) return createStaff(req, res, next);
  return enquiryLimiter(req, res, (err) => (err ? next(err) : submitPublic(req, res, next)));
};

exports.getEnquiries = catchAsync(async (req, res) => {
  const result = await svc.listEnquiries(req.libraryId, req.query, branchFilter(req));
  ApiResponse.ok(res, result.data, 'Enquiries retrieved successfully', {
    total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages
  });
});

exports.getEnquiryById = catchAsync(async (req, res) => {
  const enquiry = await svc.getEnquiry(req.params.id, req.libraryId);
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  ApiResponse.ok(res, enquiry, 'Enquiry retrieved successfully');
});

exports.updateEnquiry = catchAsync(async (req, res) => {
  const enquiry = await svc.updateEnquiry(req.params.id, req.libraryId, req.body, req.user._id);
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  audit(req, 'enquiry.update', 'Enquiry', enquiry._id, { status: req.body.status });
  ApiResponse.ok(res, enquiry, 'Enquiry updated successfully');
});

exports.deleteEnquiry = catchAsync(async (req, res) => {
  const enquiry = await svc.deleteEnquiry(req.params.id, req.libraryId);
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  audit(req, 'enquiry.delete', 'Enquiry', enquiry._id);
  ApiResponse.ok(res, null, 'Enquiry deleted successfully');
});

exports.convertEnquiry = catchAsync(async (req, res) => {
  const result = await require('../utils/securityEvent').flagOnMiss(req, require('../models/enquiry.model'), req.params.id, 'Enquiry',
    () => svc.convertEnquiry(req.params.id, req.libraryId, req.body, req));
  audit(req, 'enquiry.convert', 'Enquiry', req.params.id, { studentId: result.student._id, created: result.created });
  ApiResponse.ok(res, result, result.created ? 'Enquiry converted to student' : 'Enquiry linked to existing student');
});

exports.getConversionStats = catchAsync(async (req, res) => {
  const data = await svc.conversionStats(req.libraryId, req.query, branchFilter(req));
  ApiResponse.ok(res, data, 'Enquiry conversion stats retrieved successfully');
});

exports.addNote = catchAsync(async (req, res) => {
  const enquiry = await svc.addNote(req.params.id, req.libraryId, req.body.text);
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  audit(req, 'enquiry.note', 'Enquiry', enquiry._id);
  ApiResponse.ok(res, enquiry, 'Note added successfully');
});
