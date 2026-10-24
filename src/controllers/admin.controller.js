const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const svc        = require('../services/admin.service');
const audit      = require('../utils/audit');
const platformSettings = require('../services/platformSettings.service');

// Registration can be paused from Platform Settings
const assertRegistrationOpen = async () => {
  await platformSettings.ensureFresh();
  if (!platformSettings.registrationOpen()) throw Object.assign(new ApiError(403, 'New library registrations are paused right now. Please try again later or contact support.'), { errorCode: 'REGISTRATION_CLOSED' });
};

exports.createAdmin = catchAsync(async (req, res) => {
  const admin = await svc.createStaff(req);
  res.status(201).json({
    success: true,
    message: 'Staff member created successfully',
    data: admin,
    admin
  });
});

// Superadmin creates an (active) library with its owner account
exports.createLibrary = catchAsync(async (req, res) => {
  const { library, admin } = await svc.createLibraryWithAdmin(req.body, req.files, req.user);
  await audit(req, 'library.create', 'Library', library._id, { name: library.name, by: 'superadmin' });
  res.status(201).json({
    success: true,
    message: 'Library created successfully.',
    data: { library, admin }
  });
});

// Public self-registration (always pending approval)
exports.sendRegistrationOtp = catchAsync(async (req, res) => {
  await assertRegistrationOpen();
  const r = await require('../services/registrationVerification.service').sendOtp(req.body.mobile);
  const dev = r.isDev && r.otp;
  res.status(200).json({ success: true, message: 'An OTP has been sent to the mobile number', data: { isOTP: true, ...(dev ? { otp: r.otp } : {}) } });
});

exports.verifyRegistrationOtp = catchAsync(async (req, res) => {
  const data = await require('../services/registrationVerification.service').verifyOtp(req.body.mobile, req.body.otp);
  res.status(200).json({ success: true, message: 'Mobile number verified', data });
});

exports.registerLibrary = catchAsync(async (req, res) => {
  await assertRegistrationOpen();
  require('../services/registrationVerification.service').assertRegistrationToken(req.body.registrationToken, req.body.mobile);
  const { library: created, admin } = await svc.createLibraryWithAdmin(req.body, req.files, null);
  // "Auto-approve new libraries" (Platform Settings): activate and provision straight away
  const library = await require('../services/onboarding.service').activateIfAutoApprove(created);
  res.status(201).json({
    success: true,
    message: library.status === 'active' ? 'Library registered and approved. You can sign in now.' : 'Library registered successfully. Awaiting Super Admin approval.',
    data: {
      library: { id: library._id, name: library.name, status: library.status, libraryCode: library.libraryCode },
      admin: { id: admin._id, name: admin.name, email: admin.email },
      status: library.status,
    }
  });
});

exports.getAdmins = catchAsync(async (req, res) => {
  const result = await svc.listStaff(req);
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
  const result = await svc.listStaff(req, { ...req.query, userType: 'admin' });
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
  const admin = await svc.getAdminById(req, id);
  res.status(200).json({
    success: true,
    message: 'User retrieved successfully',
    data: admin
  });
});

exports.updateAdmin = catchAsync(async (req, res) => {
  const id = req.params.id || req.user?._id;
  if (!id) throw new ApiError(404, 'User ID not provided');
  const admin = await svc.updateAdmin(req, id);
  res.status(200).json({
    success: true,
    message: 'User profile updated successfully',
    data: admin
  });
});

exports.updateAdminStatus = catchAsync(async (req, res) => {
  const admin = await svc.updateStatus(req, req.params.id, req.body.status);
  res.status(200).json({
    success: true,
    message: 'User status updated successfully',
    data: admin
  });
});

exports.deleteAdmin = catchAsync(async (req, res) => {
  await svc.softDelete(req, req.params.id);
  res.status(200).json({
    success: true,
    message: 'User deleted successfully'
  });
});

exports.resetStaffPassword = catchAsync(async (req, res) => {
  await svc.resetPasswordByOwner(req, req.params.id, req.body.newPassword);
  res.status(200).json({
    success: true,
    message: 'Password reset successfully'
  });
});

exports.getDashboard = catchAsync(async (req, res) => {
  const dashSvc = require('../services/dashboard.service');
  const { tenantId } = require('../middlewares/access.middleware');
  const libraryId = tenantId(req);
  if (!libraryId) throw new ApiError(400, 'No library associated with this account');
  const data = await dashSvc.getAdminDashboardData(libraryId, req);
  res.status(200).json({
    success: true,
    message: 'Dashboard data retrieved successfully',
    data
  });
});
