const jwt = require('jsonwebtoken');
const Admin = require('../models/admin.model');
const Role = require('../models/role.model');
const PlatformPlan = require('../models/platformPlan.model');
const config = require('../config/config');
const platformSettings = require('../services/platformSettings.service');
const { expandPermissions } = require('../seed/permissionCatalog');
const { getSubscriptionState } = require('../services/subscriptionState.service');

// Every call used to cost 3-4 sequential database round trips (user, role, permissions, library).
// The resolved context is kept in memory for a short time; changes (disabled user, role edit, suspended
// library) take effect within AUTH_CACHE_TTL_MS, and a password reset still ends sessions at once
// because tokensValidAfter is checked against the cached user on every request.
const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS ?? 30000);
const AUTH_CACHE_MAX = 500;
const authCache = new Map(); // key -> { at, user, graceDays }

const cacheGet = (key) => {
    if (!AUTH_CACHE_TTL_MS) return null;
    const hit = authCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > AUTH_CACHE_TTL_MS) { authCache.delete(key); return null; }
    return hit;
};
const cacheSet = (key, entry) => {
    if (!AUTH_CACHE_TTL_MS) return;
    if (authCache.size >= AUTH_CACHE_MAX) authCache.delete(authCache.keys().next().value);
    authCache.set(key, { at: Date.now(), ...entry });
};
/** Drop one user's cached context (call after changing their status / role / library). */
const invalidateAuthCache = (userId) => {
    for (const k of authCache.keys()) if (k.endsWith(':' + String(userId))) authCache.delete(k);
};

const Authentication = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, code: 401, message: 'Authentication required' });
        }

        const decoded = jwt.verify(token, config.jwt.secret);
        let user;
        const cacheKey = (decoded.type === 'student' ? 'student:' : 'admin:') + decoded.id;
        const cached = cacheGet(cacheKey);

        if (cached) {
            user = cached.user;
        } else if (decoded.type === 'student') {
            const Student = require('../models/student.model');
            user = await Student.findById(decoded.id).populate('libraryId');
            if (!user || user.isDeleted || user.status === 'inactive' || user.status === 'suspended') {
                return res.status(401).json({ success: false, code: 401, message: 'Student not found or inactive' });
            }
            user.userType = 'student';
        } else {
            // This covers 'superadmin', 'admin', and 'staff'
            user = await Admin.findById(decoded.id)
                .populate({
                    path: 'roleId',
                    populate: { path: 'permissionIds' }
                })
                .populate('libraryId');
            if (!user || !user.status) {
                return res.status(401).json({ success: false, code: 401, message: 'User not found or inactive' });
            }
            // user.userType is already defined in the model
        }
        if (!cached) cacheSet(cacheKey, { user });

        // Sessions started before a password reset are dead
        if (user.tokensValidAfter && decoded.iat < Math.floor(user.tokensValidAfter.getTime() / 1000)) {
            return res.status(401).json({ success: false, code: 401, message: 'Session expired. Please log in again.' });
        }
        // Support access: the superadmin who issued the token must still be an active superadmin
        if (decoded.impersonatedBy) {
            const issuerKey = 'issuer:' + decoded.impersonatedBy;
            let issuer = cacheGet(issuerKey)?.ok;
            if (!issuer) {
                issuer = !!(await Admin.findOne({ _id: decoded.impersonatedBy, userType: 'superadmin', status: true }).select('_id').lean());
                if (issuer) cacheSet(issuerKey, { ok: true });
            }
            if (!issuer) return res.status(401).json({ success: false, code: 401, message: 'Support session is no longer valid' });
        }

        // Maintenance mode: only super admins keep working (your own /me stays open so the app can show the notice)
        await platformSettings.ensureFresh();
        if (platformSettings.isMaintenance() && user.userType !== 'superadmin' && !(req.method === 'GET' && req.path === '/me')) {
            return res.status(503).json({ success: false, code: 503, maintenance: true, message: platformSettings.maintenanceMessage() });
        }

        // Tenant: expose a plain ObjectId and the library document separately.
        // req.user.libraryId stays populated for legacy code; new code uses req.libraryId.
        const library = user.libraryId && user.libraryId._id ? user.libraryId : null;
        const libraryId = library ? library._id : (user.libraryId || null);

        // Non-superadmin tenants can only operate while their library is approved and active.
        // Exception: GET /me stays reachable so the owner's app can show "pending / rejected / suspended" and the reason.
        if (user.userType !== 'superadmin') {
            if (!library || library.isDeleted || library.status !== 'active') {
                const state = library && !library.isDeleted ? library.status : 'missing';
                const isMe = req.method === 'GET' && req.path === '/me';
                // A library suspended for non-payment must still reach the subscription endpoints to renew
                const renewing = !!library && !library.isDeleted && library.status === 'suspended'
                    && library.statusReason === 'Subscription expired' && user.userType === 'admin'
                    && req.path.startsWith('/libraries/subscription');
                if (!(isMe && library && !library.isDeleted) && !renewing) {
                    return res.status(403).json({
                        success: false, code: 403, libraryStatus: state, statusReason: library?.statusReason || null,
                        message: state === 'pending' ? 'Your library is awaiting Super Admin approval.'
                            : state === 'rejected' ? 'Your library registration was rejected.'
                            : state === 'suspended' ? 'Your library is suspended. Please contact support.'
                            : 'Library not found or inactive.'
                    });
                }
            } else if (user.userType !== 'student' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
                && !req.path.startsWith('/libraries/subscription') && req.path !== '/me') {
                // Subscription ended and the grace window is over: read-only until renewed (spec 29).
                // Subscription payment endpoints stay open so the owner can renew.
                const planKey = 'plan:' + library.subscriptionPlanId;
                let plan = null;
                if (library.subscriptionPlanId) {
                    plan = cacheGet(planKey)?.plan;
                    if (!plan) {
                        plan = await PlatformPlan.findById(library.subscriptionPlanId).select('graceDays').lean();
                        cacheSet(planKey, { plan });
                    }
                }
                const sub = getSubscriptionState(library, plan);
                if (sub.isExpired) {
                    return res.status(402).json({
                        success: false, code: 402, libraryStatus: 'subscription_expired',
                        message: 'Your subscription has expired. Renew your plan to make changes; you can still view your data.'
                    });
                }
            }
        }

        // Attach permissions to request for easy access in middleware
        req.user = user;
        req.libraryId = libraryId;
        req.library = library;
        req.userType = user.userType; // Use the type from the database
        req.user.sub = decoded.id; 
        // Set when a superadmin acts as the owner (support impersonation token)
        req.impersonatedBy = decoded.impersonatedBy || null;
        // A disabled role grants nothing. Legacy and dotted keys are aliased (see seed/permissionCatalog).
        req.permissions = user.roleId && user.roleId.status !== false
            ? expandPermissions((user.roleId.permissionIds || []).map(p => p.key))
            : [];

        next();
    } catch (error) {
        return res.status(401).json({ success: false, code: 401, message: 'Invalid or expired token' });
    }
};

module.exports = Authentication;
module.exports.invalidateAuthCache = invalidateAuthCache;
