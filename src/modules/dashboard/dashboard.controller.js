const catchAsync = require('../../utils/catchAsync');
const svc        = require('../../services/dashboard.service');

exports.getAdminDashboard = catchAsync(async (req, res) => {
  if (!req.user.libraryId)
    return res.status(400).json({ success: false, message: 'No library associated with this account' });
  const data = await svc.getAdminDashboardData(req.user.libraryId);
  res.json({ success: true, data });
});

exports.getSuperAdminDashboard = catchAsync(async (req, res) => {
  const data = await svc.getSuperAdminDashboardData();
  res.json({ success: true, data });
});
