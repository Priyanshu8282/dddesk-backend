/**
 * Plan feature entitlements (spec 29 "feature entitlement checks").
 *
 * PlatformPlan.features is a list of strings. Super admins may already store free-text marketing bullets there
 * ("Unlimited reports"), so entitlement enforcement is OPT-IN per plan:
 *   - if the plan's features contain NO key from FEATURE_KEYS below -> every feature is allowed (backward compatible);
 *   - as soon as the plan lists at least one known key, only the listed known keys are allowed.
 * Feature keys are matched case-insensitively and trimmed.
 *
 * Limits live on PlatformPlan (maxStudents, maxSeats, maxStaff, maxBranches) and are snapshotted onto
 * Library.planLimits at assignment/payment time.
 */
const FEATURE_KEYS = Object.freeze({
    ai: 'ai',                       // AI assistant (/ai, /assistant)
    reports: 'reports',             // reports & BI
    website: 'website',             // public library website
    multiBranch: 'multiBranch',     // more than one branch
    onlinePayments: 'onlinePayments',
    sms: 'sms',
    whatsapp: 'whatsapp',
    exports: 'exports'              // xlsx/csv exports
});
const FEATURE_LIST = Object.freeze(Object.values(FEATURE_KEYS));

/**
 * LIMITS: key -> how usage is counted and whether 0 means "unlimited"
 * (maxStaff / maxBranches treat 0 as unlimited to match admin.service; students/seats are hard numbers).
 */
const LIMITS = Object.freeze({
    maxStudents: { usage: 'students', label: 'students', zeroMeansUnlimited: false },
    maxSeats: { usage: 'seats', label: 'seats', zeroMeansUnlimited: false },
    maxStaff: { usage: 'staff', label: 'staff accounts', zeroMeansUnlimited: true },
    maxBranches: { usage: 'branches', label: 'branches', zeroMeansUnlimited: true }
});
const LIMIT_KEYS = Object.freeze(Object.keys(LIMITS));

const normalise = (features) => (Array.isArray(features) ? features : [])
    .map((f) => String(f || '').trim().toLowerCase());

/** Pure: does a plan's feature list allow `key`? */
const planAllowsFeature = (features, key) => {
    const known = new Map(FEATURE_LIST.map((k) => [k.toLowerCase(), k]));
    const have = normalise(features).filter((f) => known.has(f));
    if (!have.length) return true; // plan does not use entitlement keys
    return have.includes(String(key).toLowerCase());
};

/** Pure: numeric limit (or null for unlimited) for a limit key given a limits object */
const effectiveLimit = (limits, key) => {
    const cfg = LIMITS[key];
    const v = limits ? limits[key] : undefined;
    if (!cfg || typeof v !== 'number' || Number.isNaN(v)) return null;
    if (v === 0 && cfg.zeroMeansUnlimited) return null;
    return v;
};

module.exports = { FEATURE_KEYS, FEATURE_LIST, LIMITS, LIMIT_KEYS, planAllowsFeature, effectiveLimit };
