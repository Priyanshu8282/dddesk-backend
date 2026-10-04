const catchAsync = require('../../utils/catchAsync');
const svc        = require('../../services/website.service');

exports.getSettings = catchAsync(async (req, res) => {
  const data = await svc.getWebsiteSettings(req.user.libraryId);
  res.json({ success: true, data });
});

exports.updateSettings = catchAsync(async (req, res) => {
  const doc = await svc.updateWebsiteSettings(req.user.libraryId, req.body);
  res.json({ success: true, message: 'Website settings saved.', data: doc });
});

exports.getPublicProfile = catchAsync(async (req, res) => {
  const data = await svc.getPublicProfile(req.params.slug);
  res.json({ success: true, data });
});
