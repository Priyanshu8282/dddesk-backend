const jwt = require('jsonwebtoken');
const Admin = require('../models/admin.model');
const Role = require('../models/role.model');
const PlatformPlan = require('../models/platformPlan.model');
const config = require('../config/config');
const { expandPermissions } = require('../seed/permissionCatalog');
const { getSubscriptionState } = require('../services/subscriptionState.service');

const Authentication = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, code: 401, message: 'Authentication required' });
        }

        const decoded = jwt.verify(token, config.jwt.secret);
        let user;

        if (decoded.type === 'student') {
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

        // Sessions started before a password reset are dead
        if (user.tokensValidAfter && decoded.iat < Math.floor(user.tokensValidAfter.getTime() / 1000)) {
            return res.status(401).json({ success: false, code: 401, message: 'Session expired. Please log in again.' });
        }
        // Support access: the superadmin who issued the token must still be an active superadmin
        if (decoded.impersonatedBy) {
            const issuer = await Admin.findOne({ _id: decoded.impersonatedBy, userType: 'superadmin', status: true }).select('_id');
            if (!issuer) return res.status(401).json({ success: false, code: 401, message: 'Support session is no longer valid' });
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
                const sub = getSubscriptionState(library, library.subscriptionPlanId ? await PlatformPlan.findById(library.subscriptionPlanId).select('graceDays').lean() : null);
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
