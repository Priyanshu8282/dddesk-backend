const ApiError = require('../utils/ApiError');

// Role guards. Run after Authentication (req.userType is set there).
const deny = (msg) => new ApiError(403, msg || 'You do not have access to this resource');

const allow = (...types) => (req, res, next) =>
    types.includes(req.userType) ? next() : next(deny());

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
