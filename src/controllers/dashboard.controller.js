const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const svc        = require('../services/dashboard.service');
const { tenantId } = require('../middlewares/access.middleware');

exports.getAdminDashboard = catchAsync(async (req, res) => {
  // owners/staff: their own library (req.libraryId); superadmin must name one with ?libraryId=
  const libraryId = tenantId(req);
  if (!libraryId) throw new ApiError(400, 'No library associated with this account');
  const data = await svc.getAdminDashboardData(libraryId, req);
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
