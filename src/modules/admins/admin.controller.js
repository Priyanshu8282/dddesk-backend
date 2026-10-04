const catchAsync = require('../../utils/catchAsync');
const ApiError   = require('../../utils/ApiError');
const svc        = require('../../services/admin.service');

exports.createAdmin = catchAsync(async (req, res) => {
  const admin = await svc.createStaff(req.body, req.files, req.user);
  res.status(201).json({ message: 'Employee created successfully', admin });
});

exports.createLibrary = catchAsync(async (req, res) => {
  const data = await svc.createLibraryWithAdmin(req.body, req.files, req.user);
  res.status(201).json({ success: true, message: 'Library and Admin created successfully', data });
});

exports.getAdmins = catchAsync(async (req, res) => {
  const result = await svc.listStaff(req.query, req.user);
  res.json({ success: true, results: result.data, data: result.data, totalResults: result.total, ...result });
});

exports.getLibraries = catchAsync(async (req, res) => {
  const result = await svc.listStaff({ ...req.query, userType: 'admin' }, req.user);
  res.json({ success: true, data: result.data, total: result.total, page: result.page, totalPages: result.totalPages, summary: result.summary });
});

exports.getAdminById = catchAsync(async (req, res) => {
  const id = req.params.id || req.user?._id;
  if (!id) throw new ApiError(404, 'User ID not provided');
  const admin = await svc.getAdminById(id);
  if (!admin) throw new ApiError(404, 'User not found');
  res.json({ success: true, data: admin });
});

exports.updateAdmin = catchAsync(async (req, res) => {
  const id = req.params.id || req.user?._id;
  if (!id) throw new ApiError(404, 'User ID not provided');
  const admin = await svc.updateAdmin(id, req.body, req.files, req.user);
  res.json({ success: true, data: admin });
});

exports.updateAdminStatus = catchAsync(async (req, res) => {
  const admin = await svc.updateStatus(req.params.id, req.body.status, req.user?._id);
  res.json({ success: true, message: 'Status updated successfully', data: admin });
});

exports.deleteAdmin = catchAsync(async (req, res) => {
  await svc.softDelete(req.params.id, req.user._id);
  res.json({ message: 'User deleted successfully' });
});

exports.changePassword = catchAsync(async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) throw new ApiError(400, 'New password is required');
  await svc.changePassword(req.user._id, newPassword);
  res.json({ success: true, message: 'Password updated successfully' });
});

// Legacy dashboard kept for backward compat — main dashboard is in dashboard.controller.js
exports.getDashboard = catchAsync(async (req, res) => {
  const dashSvc = require('../../services/dashboard.service');
  const libraryId = req.user.libraryId?._id || req.user.libraryId || req.user._id;
  const data = await dashSvc.getAdminDashboardData(libraryId);
  res.json({ success: true, data });
});
