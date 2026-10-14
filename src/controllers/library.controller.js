const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const libraryService = require('../services/library.service');
const superLibraryService = require('../services/superLibrary.service');
const authService = require('../services/auth.service');
const auditService = require('../services/audit.service');
const audit = require('../utils/audit');
const { tenantId } = require('../middlewares/access.middleware');

const requireTenant = (req) => {
    const id = tenantId(req);
    if (!id) throw new ApiError(400, 'No library associated with this account');
    return id;
};

// GET /libraries/profile
exports.getProfile = catchAsync(async (req, res) => {
    const library = await libraryService.getProfile(requireTenant(req));
    res.status(200).json({ success: true, message: 'Profile fetched successfully', data: library });
});

// PUT /libraries/profile
exports.updateProfile = catchAsync(async (req, res) => {
    const library = await libraryService.updateProfile(req, requireTenant(req));
    res.status(200).json({ success: true, message: 'Profile updated successfully', data: library });
});

// PATCH /libraries/change-password (current password required; hashed once by the Admin model hook)
exports.changePassword = catchAsync(async (req, res) => {
    await authService.changePassword(req.user._id, req.userType, req.body.currentPassword, req.body.newPassword);
    await audit(req, 'auth.password_change', 'Admin', req.user._id);
    res.status(200).json({ success: true, message: 'Password updated successfully' });
});

// GET /libraries/my-plan
exports.getMyPlan = catchAsync(async (req, res) => {
    const data = await libraryService.getMyPlan(requireTenant(req));
    res.json({ success: true, message: 'Plan retrieved successfully', data });
});

// GET /libraries/audit-logs (owner: own library only)
exports.getAuditLogs = catchAsync(async (req, res) => {
    const { data, pagination } = await auditService.queryLogs(req.query, { forceLibraryId: requireTenant(req) });
    res.json({ success: true, message: 'Audit logs retrieved successfully', data, pagination });
});

// ---- Superadmin library management (legacy endpoints under /libraries, delegating to superLibrary service) ----

exports.getAllLibraries = catchAsync(async (req, res) => {
    const data = await superLibraryService.listLibraries(req.query);
    res.json({ success: true, message: 'Libraries retrieved successfully', data: data.libraries, ...data });
});

exports.getLibraryById = catchAsync(async (req, res) => {
    const data = await superLibraryService.getLibraryById(req.params.id);
    res.json({ success: true, message: 'Library retrieved successfully', data });
});

exports.updateLibrary = catchAsync(async (req, res) => {
    const lib = await superLibraryService.updateLibrary(req.params.id, req.body, req.user._id, req.ip);
    res.json({ success: true, message: 'Library updated successfully', data: lib });
});

exports.deleteLibrary = catchAsync(async (req, res) => {
    await superLibraryService.deleteLibrary(req.params.id, req.user._id, req.ip);
    res.json({ success: true, message: 'Library deleted successfully' });
});

// PATCH /libraries/status/:id  body: { status: 'active'|'suspended'|'inactive'|'rejected', reason? }
// Library status only moves through the superadmin workflow (approve / reject / suspend / reinstate).
exports.updateLibraryStatus = catchAsync(async (req, res) => {
    const { status, reason } = req.body;
    const current = await superLibraryService.getLibraryById(req.params.id);
    let lib;
    if (status === 'active') {
        lib = current.status === 'pending'
            ? (await superLibraryService.approveLibrary(req.params.id, req.user._id, req.ip)).library
            : await superLibraryService.reinstateLibrary(req.params.id, req.user._id, req.ip);
    } else if (status === 'suspended' || status === 'inactive') {
        lib = await superLibraryService.suspendLibrary(req.params.id, reason, req.user._id, req.ip);
    } else if (status === 'rejected') {
        lib = await superLibraryService.rejectLibrary(req.params.id, reason, req.user._id, req.ip);
    } else {
        throw new ApiError(400, "status must be one of 'active', 'suspended', 'inactive', 'rejected'");
    }
    res.json({ success: true, message: `Library status updated to ${lib.status}`, data: lib });
});
