const catchAsync = require('../../utils/catchAsync');
const svc        = require('../../services/superLibrary.service');

exports.getAllLibraries = catchAsync(async (req, res) => {
  const data = await svc.listLibraries(req.query);
  res.json({ success: true, data });
});

exports.getLibraryById = catchAsync(async (req, res) => {
  const data = await svc.getLibraryById(req.params.id);
  res.json({ success: true, data });
});

exports.approveLibrary = catchAsync(async (req, res) => {
  const lib = await svc.approveLibrary(req.params.id, req.user._id, req.ip);
  res.json({ success: true, message: 'Library approved', data: lib });
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
  const { lib, planName } = await svc.assignPlan(req.params.id, req.body.planId, req.body.subscriptionExpiry, req.user._id, req.ip);
  res.json({ success: true, message: `Plan "${planName}" assigned to ${lib.name}`, data: lib });
});

exports.getLibraryPlan = catchAsync(async (req, res) => {
  const data = await svc.getLibraryPlan(req.params.id);
  res.json({ success: true, data });
});

exports.createLibrary = catchAsync(async (req, res) => {
  const data = await svc.createLibrary(req.body, req.user._id, req.ip);
  res.status(201).json({ success: true, message: 'Library created successfully', data });
});

exports.updateLibrary = catchAsync(async (req, res) => {
  const lib = await svc.updateLibrary(req.params.id, req.body, req.user._id, req.ip);
  res.json({ success: true, message: 'Library updated', data: lib });
});

exports.deleteLibrary = catchAsync(async (req, res) => {
  await svc.deleteLibrary(req.params.id, req.user._id, req.ip);
  res.json({ success: true, message: 'Library deleted' });
});
