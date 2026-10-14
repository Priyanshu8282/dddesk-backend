/**
 * Plan entitlement guards. Run after Authentication (needs req.libraryId / req.userType).
 *
 *   router.use(requireFeature('ai'));                     // route group needs a plan feature
 *   router.post('/', limitGuard('maxBranches'), handler); // middleware flavour of a limit check
 *   await enforceLimit('maxBranches', libraryId);         // function flavour for service code
 *
 * Feature keys: utils/features.js. Plans without any known feature key allow everything (backward compatible).
 * Super admins always pass.
 */
const catchAsync = require('../utils/catchAsync');
const { FEATURE_LIST } = require('../utils/features');
const ent = require('../services/entitlement.service');

const requireFeature = (...keys) => {
    const bad = keys.filter((k) => !FEATURE_LIST.includes(k));
    if (bad.length) throw new Error(`requireFeature: unknown feature key(s): ${bad.join(', ')}`);
    return catchAsync(async (req, res, next) => {
        if (req.userType === 'superadmin' || !req.libraryId) return next();
        for (const k of keys) await ent.assertFeature(req.libraryId, k);
        return next();
    });
};

const limitGuard = (limitKey, adding = 1) => catchAsync(async (req, res, next) => {
    if (req.userType === 'superadmin' || !req.libraryId) return next();
    await ent.enforceLimit(limitKey, req.libraryId, adding);
    return next();
});

module.exports = { requireFeature, limitGuard, enforceLimit: ent.enforceLimit, assertFeature: ent.assertFeature, getUsage: ent.getUsage };
