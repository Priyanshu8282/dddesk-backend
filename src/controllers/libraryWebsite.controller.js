const catchAsync = require('../utils/catchAsync');
const svc        = require('../services/website.service');

exports.getSettings = catchAsync(async (req, res) => {
  const data = await svc.getWebsiteSettings(req.user.libraryId);
  res.status(200).json({
    success: true,
    message: 'Website settings retrieved successfully',
    data
  });
});

exports.updateSettings = catchAsync(async (req, res) => {
  const doc = await svc.updateWebsiteSettings(req.user.libraryId, req.body);
  res.status(200).json({
    success: true,
    message: 'Website settings saved successfully',
    data: doc
  });
});

exports.getPublicProfile = catchAsync(async (req, res) => {
  const data = await svc.getPublicProfile(req.params.slug);
  res.status(200).json({
    success: true,
    message: 'Public profile retrieved successfully',
    data
  });
});
