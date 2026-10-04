const catchAsync = require('../../utils/catchAsync');
const ApiError   = require('../../utils/ApiError');
const svc        = require('../../services/enquiry.service');

exports.createEnquiry = catchAsync(async (req, res) => {
  const enquiry = await svc.createEnquiry({ ...req.body, libraryId: req.user.libraryId, createdBy: req.user._id });
  res.status(201).json({ success: true, message: 'Enquiry created', data: enquiry });
});

exports.getEnquiries = catchAsync(async (req, res) => {
  const result = await svc.listEnquiries(req.user.libraryId, req.query);
  res.json({ success: true, ...result });
});

exports.getEnquiryById = catchAsync(async (req, res) => {
  const enquiry = await svc.getEnquiry(req.params.id, req.user.libraryId);
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  res.json({ success: true, data: enquiry });
});

exports.updateEnquiry = catchAsync(async (req, res) => {
  const enquiry = await svc.updateEnquiry(req.params.id, req.user.libraryId, req.body);
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  res.json({ success: true, message: 'Enquiry updated', data: enquiry });
});

exports.deleteEnquiry = catchAsync(async (req, res) => {
  const enquiry = await svc.deleteEnquiry(req.params.id, req.user.libraryId);
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  res.json({ success: true, message: 'Enquiry deleted' });
});
