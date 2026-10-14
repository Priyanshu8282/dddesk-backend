/**
 * Entitlement checks (spec 29): plan features and plan limits for a library.
 * Feature keys and semantics are documented in utils/features.js.
 */
const Library = require('../models/library.model');
const PlatformPlan = require('../models/platformPlan.model');
const Student = require('../models/student.model');
const Seat = require('../models/seat.model');
const Admin = require('../models/admin.model');
const Branch = require('../models/branch.model');
const ApiError = require('../utils/ApiError');
const { LIMITS, planAllowsFeature, effectiveLimit } = require('../utils/features');

/** Current usage counts used for every limit check */
const getUsage = async (libraryId) => {
    const [students, seats, staff, branches] = await Promise.all([
        Student.countDocuments({ libraryId, isDeleted: false }),
        Seat.countDocuments({ libraryId, isDeleted: false }),
        Admin.countDocuments({ libraryId, userType: 'staff', isDeleted: { $ne: true } }),
        Branch.countDocuments({ libraryId, isDeleted: false })
    ]);
    return { students, seats, staff, branches };
};

/** Usage vs limits object for the owner screens */
const getEntitlements = async (libraryId, { library, plan } = {}) => {
    const lib = library || await Library.findById(libraryId).select('planLimits subscriptionPlanId').lean();
    const p = plan !== undefined ? plan
        : (lib && lib.subscriptionPlanId ? await PlatformPlan.findById(lib.subscriptionPlanId).select('features').lean() : null);
    const usage = await getUsage(libraryId);
    const limits = {};
    for (const [key, cfg] of Object.entries(LIMITS)) {
        limits[cfg.usage] = { used: usage[cfg.usage], limit: effectiveLimit(lib && lib.planLimits, key) };
    }
    return { features: (p && p.features) || [], usage: limits };
};

const loadPlanFeatures = async (libraryId) => {
    const lib = await Library.findById(libraryId).select('subscriptionPlanId').lean();
    if (!lib || !lib.subscriptionPlanId) return null; // no plan assigned -> no entitlement restrictions
    const plan = await PlatformPlan.findById(lib.subscriptionPlanId).select('features').lean();
    return plan ? plan.features || [] : null;
};

const featureMessage = (key) => `Your current plan does not include the "${key}" feature. Upgrade your plan to use it.`;

/** Throws 403 when the library's plan lists entitlement keys and `key` is not among them */
const assertFeature = async (libraryId, key) => {
    if (!libraryId) return;
    const features = await loadPlanFeatures(libraryId);
    if (features === null) return;
    if (!planAllowsFeature(features, key)) throw new ApiError(403, featureMessage(key));
};

/**
 * Throws 403 if adding `adding` more of the resource would exceed the plan limit.
 * limitKey: maxStudents | maxSeats | maxStaff | maxBranches
 */
const enforceLimit = async (limitKey, libraryId, adding = 1) => {
    const cfg = LIMITS[limitKey];
    if (!cfg) throw new Error(`Unknown limit: ${limitKey}`);
    const lib = await Library.findById(libraryId).select('planLimits').lean();
    if (!lib) return;
    const limit = effectiveLimit(lib.planLimits, limitKey);
    if (limit === null) return;
    const usage = await getUsage(libraryId);
    if (usage[cfg.usage] + adding > limit) {
        throw new ApiError(403, `Plan limit reached: your plan allows ${limit} ${cfg.label} (currently ${usage[cfg.usage]}). Upgrade your plan to add more.`);
    }
    return { limit, used: usage[cfg.usage] };
};

module.exports = { getUsage, getEntitlements, assertFeature, enforceLimit, loadPlanFeatures };
