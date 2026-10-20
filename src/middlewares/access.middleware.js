const ApiError = require('../utils/ApiError');
const securityLog = require('../utils/securityLog');

// Role guards. Run after Authentication (req.userType is set there).
const deny = (msg) => new ApiError(403, msg || 'You do not have access to this resource');

const allow = (...types) => (req, res, next) => {
    if (types.includes(req.userType)) return next();
    // Say exactly who was refused where, so a blocked call is easy to trace in the server log
    console.warn(`[403] ${req.method} ${req.originalUrl} - role '${req.userType}' not in [${types.join(', ')}] (user ${req.user?._id})`);
    securityLog.record(req, { type: 'forbidden', outcome: 'blocked', reason: 'wrong_role', userId: req.user?._id || null, userType: req.userType || null, libraryId: req.libraryId || null, identifier: req.user?.email || null, meta: { allowed: types } });
    return next(deny());
};

const requireSuperAdmin = allow('superadmin');
// Library owner (and superadmin acting on a tenant)
const requireOwner = allow('admin', 'superadmin');
// Anyone running the library: owner, staff, superadmin. Never students.
const requireStaff = allow('admin', 'staff', 'superadmin');
const requireStudent = allow('student');

// Staff must hold one of the permission keys; owners and superadmins pass.
const requirePermission = (...keys) => (req, res, next) => {
    if (req.userType === 'admin' || req.userType === 'superadmin') return next();
    if (req.userType === 'staff' && keys.some((k) => (req.permissions || []).includes(k))) return next();
    return next(deny('You do not have permission to perform this action'));
};

// Tenant for a request. Only superadmin may target another tenant via ?libraryId=.
const tenantId = (req) => {
    if (req.userType === 'superadmin') {
        return req.query?.libraryId || req.body?.libraryId || req.libraryId || null;
    }
    return req.libraryId;
};

module.exports = { allow, requireSuperAdmin, requireOwner, requireStaff, requireStudent, requirePermission, tenantId };
