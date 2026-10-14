const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const svc        = require('../services/enquiry.service');

exports.createEnquiry = catchAsync(async (req, res) => {
  let libraryId = req.user?.libraryId || req.body.libraryId;
  if (!libraryId && req.body.slug) {
    const Library = require('../models/library.model');
    const lib = await Library.findOne({ slug: req.body.slug });
    if (lib) libraryId = lib._id;
  }
  if (!libraryId) {
    throw new ApiError(400, 'Library ID is required to submit an enquiry');
  }

  const enquiry = await svc.createEnquiry({
    ...req.body,
    libraryId,
    createdBy: req.user?._id || null
  });
  res.status(201).json({
    success: true,
    message: 'Enquiry submitted successfully',
    data: enquiry
  });
});

exports.getEnquiries = catchAsync(async (req, res) => {
  const result = await svc.listEnquiries(req.user.libraryId, req.query);
  res.status(200).json({
    success: true,
    message: 'Enquiries retrieved successfully',
    data: result.enquiries || result.data || result,
    ...result
  });
});

exports.getEnquiryById = catchAsync(async (req, res) => {
  const enquiry = await svc.getEnquiry(req.params.id, req.user.libraryId);
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  res.status(200).json({
    success: true,
    message: 'Enquiry retrieved successfully',
    data: enquiry
  });
});

exports.updateEnquiry = catchAsync(async (req, res) => {
  const enquiry = await svc.updateEnquiry(req.params.id, req.user.libraryId, req.body);
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  res.status(200).json({
    success: true,
    message: 'Enquiry updated successfully',
    data: enquiry
  });
});

exports.deleteEnquiry = catchAsync(async (req, res) => {
  const enquiry = await svc.deleteEnquiry(req.params.id, req.user.libraryId);
  if (!enquiry) throw new ApiError(404, 'Enquiry not found');
  res.status(200).json({
    success: true,
    message: 'Enquiry deleted successfully'
  });
});
