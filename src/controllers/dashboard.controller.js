const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const svc        = require('../services/dashboard.service');

exports.getAdminDashboard = catchAsync(async (req, res) => {
  if (!req.user.libraryId)
    throw new ApiError(400, 'No library associated with this account');
  const data = await svc.getAdminDashboardData(req.user.libraryId);
  res.status(200).json({
    success: true,
    message: 'Admin dashboard data retrieved successfully',
    data
  });
});

exports.getSuperAdminDashboard = catchAsync(async (req, res) => {
  const data = await svc.getSuperAdminDashboardData();
  res.status(200).json({
    success: true,
    message: 'Super admin dashboard data retrieved successfully',
    data
  });
});
