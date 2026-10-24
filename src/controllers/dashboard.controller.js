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

// ---- Role-based summaries (contract: backend/doc/dashboard-contract.md) ----
const summarySvc = require('../services/dashboardSummary.service');
const realtime = require('../realtime');

const ok = (res, message, data) => res.status(200).json({ success: true, message, data });

// superadmin without ?libraryId= -> platform summary; owners/staff (and superadmin with ?libraryId=) -> library summary
const wantsPlatform = (req) => req.userType === 'superadmin' && !req.query.libraryId;

exports.getSummary = catchAsync(async (req, res) => {
  if (wantsPlatform(req)) {
    const range = summarySvc.pickSuperRange(req.query.range);
    return ok(res, 'Dashboard summary retrieved successfully', await summarySvc.getSuperadminSummary(range));
  }
  const libraryId = tenantId(req);
  if (!libraryId) throw new ApiError(400, 'No library associated with this account');
  const range = summarySvc.pickLibraryRange(req.query.range);
  return ok(res, 'Dashboard summary retrieved successfully', await summarySvc.getLibrarySummary(libraryId, req, range));
});

exports.getCharts = catchAsync(async (req, res) => {
  if (wantsPlatform(req)) {
    const range = summarySvc.pickSuperRange(req.query.range);
    return ok(res, 'Dashboard charts retrieved successfully', await summarySvc.getSuperadminCharts(range));
  }
  const libraryId = tenantId(req);
  if (!libraryId) throw new ApiError(400, 'No library associated with this account');
  const range = summarySvc.pickLibraryRange(req.query.range);
  return ok(res, 'Dashboard charts retrieved successfully', await summarySvc.getLibraryCharts(libraryId, req, range));
});

exports.getRealtimeInfo = catchAsync(async (req, res) => ok(res, 'Realtime info', realtime.info()));
