const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const svc        = require('../services/admin.service');

exports.createAdmin = catchAsync(async (req, res) => {
  const admin = await svc.createStaff(req.body, req.files, req.user);
  res.status(201).json({
    success: true,
    message: 'Staff member created successfully',
    data: admin,
    admin
  });
});

exports.createLibrary = catchAsync(async (req, res) => {
  const data = await svc.createLibraryWithAdmin(req.body, req.files, req.user);
  res.status(201).json({
    success: true,
    message: 'Library registered successfully. Awaiting approval.',
    data
  });
});

exports.getAdmins = catchAsync(async (req, res) => {
  const result = await svc.listStaff(req.query, req.user);
  res.status(200).json({
    success: true,
    message: 'Staff retrieved successfully',
    data: result.data,
    results: result.data,
    totalResults: result.total,
    ...result
  });
});

exports.getLibraries = catchAsync(async (req, res) => {
  const result = await svc.listStaff({ ...req.query, userType: 'admin' }, req.user);
  res.status(200).json({
    success: true,
    message: 'Libraries retrieved successfully',
    data: result.data,
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
    summary: result.summary
  });
});

exports.getAdminById = catchAsync(async (req, res) => {
  const id = req.params.id || req.user?._id;
  if (!id) throw new ApiError(404, 'User ID not provided');
  const admin = await svc.getAdminById(id);
  if (!admin) throw new ApiError(404, 'User not found');
  res.status(200).json({
    success: true,
    message: 'User retrieved successfully',
    data: admin
  });
});

exports.updateAdmin = catchAsync(async (req, res) => {
  const id = req.params.id || req.user?._id;
  if (!id) throw new ApiError(404, 'User ID not provided');
  const admin = await svc.updateAdmin(id, req.body, req.files, req.user);
  res.status(200).json({
    success: true,
    message: 'User profile updated successfully',
    data: admin
  });
});

exports.updateAdminStatus = catchAsync(async (req, res) => {
  const admin = await svc.updateStatus(req.params.id, req.body.status, req.user?._id);
  res.status(200).json({
    success: true,
    message: 'User status updated successfully',
    data: admin
  });
});

exports.deleteAdmin = catchAsync(async (req, res) => {
  await svc.softDelete(req.params.id, req.user._id);
  res.status(200).json({
    success: true,
    message: 'User deleted successfully'
  });
});

exports.changePassword = catchAsync(async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) throw new ApiError(400, 'New password is required');
  await svc.changePassword(req.user._id, newPassword);
  res.status(200).json({
    success: true,
    message: 'Password updated successfully'
  });
});

exports.getDashboard = catchAsync(async (req, res) => {
  const dashSvc = require('../services/dashboard.service');
  const libraryId = req.user.libraryId?._id || req.user.libraryId || req.user._id;
  const data = await dashSvc.getAdminDashboardData(libraryId);
  res.status(200).json({
    success: true,
    message: 'Dashboard data retrieved successfully',
    data
  });
});
