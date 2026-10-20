const catchAsync = require('../utils/catchAsync');
const svc        = require('../services/superLibrary.service');

exports.getAllLibraries = catchAsync(async (req, res) => {
  const data = await svc.listLibraries(req.query);
  res.json({ success: true, message: 'Libraries retrieved successfully', data });
});

exports.getLibraryById = catchAsync(async (req, res) => {
  const data = await svc.getLibraryById(req.params.id);
  res.json({ success: true, message: 'Library retrieved successfully', data });
});

exports.approveLibrary = catchAsync(async (req, res) => {
  const { library, onboarding } = await svc.approveLibrary(req.params.id, req.user._id, req.ip);
  res.json({ success: true, message: 'Library approved', data: library, onboarding });
});

exports.rejectLibrary = catchAsync(async (req, res) => {
  const lib = await svc.rejectLibrary(req.params.id, req.body.reason, req.user._id, req.ip);
  res.json({ success: true, message: 'Library rejected', data: lib });
});

exports.suspendLibrary = catchAsync(async (req, res) => {
  const lib = await svc.suspendLibrary(req.params.id, req.body.reason, req.user._id, req.ip);
  res.json({ success: true, message: 'Library suspended', data: lib });
});

exports.reinstateLibrary = catchAsync(async (req, res) => {
  const lib = await svc.reinstateLibrary(req.params.id, req.user._id, req.ip);
  res.json({ success: true, message: 'Library reinstated', data: lib });
});

exports.assignPlan = catchAsync(async (req, res) => {
  const { lib, planName } = await svc.assignPlan(
    req.params.id, req.body.planId, req.body.subscriptionExpiry, req.user._id, req.ip, { isTrial: req.body.isTrial }
  );
  res.json({ success: true, message: `Plan "${planName}" assigned to ${lib.name}`, data: lib });
});

exports.getLibraryPlan = catchAsync(async (req, res) => {
  const data = await svc.getLibraryPlan(req.params.id);
  res.json({ success: true, message: 'Library plan retrieved successfully', data });
});

exports.createLibrary = catchAsync(async (req, res) => {
  const data = await svc.createLibrary(req.body, req.user, req.ip, req.file ? [req.file] : null);
  res.status(201).json({ success: true, message: 'Library created successfully', data });
});

exports.updateLibrary = catchAsync(async (req, res) => {
  const lib = await svc.updateLibrary(req.params.id, req.body, req.user._id, req.ip, { file: req.file || null, removeImage: String(req.body.removeOwnerImage) === 'true' });
  res.json({ success: true, message: 'Library updated', data: lib });
});

exports.deleteLibrary = catchAsync(async (req, res) => {
  await svc.deleteLibrary(req.params.id, req.user._id, req.ip);
  res.json({ success: true, message: 'Library deleted' });
});

exports.changeSlug = catchAsync(async (req, res) => {
  const lib = await svc.changeSlug(req.params.id, req.body.slug, req.user._id, req.ip);
  res.json({
    success: true, message: 'Slug updated. The previous address will keep redirecting.',
    data: { id: lib._id, slug: lib.slug, previousSlugs: lib.previousSlugs, subdomain: lib.subdomain, websiteUrl: lib.websiteUrl },
  });
});

exports.impersonate = catchAsync(async (req, res) => {
  const data = await svc.impersonate(req.params.id, req.user, req.ip);
  res.json({ success: true, message: 'Impersonation token issued (valid for 30 minutes)', data });
});
