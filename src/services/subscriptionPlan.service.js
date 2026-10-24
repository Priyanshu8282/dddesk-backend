/**
 * SaaS plan lifecycle for the library owner (spec 29):
 * current state, plan change (upgrade now with proration / downgrade at period end), cancel and resume.
 * Pure maths lives in utils/subscriptionLifecycle.js.
 */
const Library = require('../models/library.model');
const PlatformPlan = require('../models/platformPlan.model');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const L = require('../utils/subscriptionLifecycle');
const { getSubscriptionState } = require('./subscriptionState.service');
const subscription = require('./subscription.service');
const entitlement = require('./entitlement.service');

const LIB_FIELDS = 'name status statusReason subscriptionPlan subscriptionPlanId subscriptionExpiry trialEndsAt subscriptionIsTrial '
    + 'billingCycle subscriptionStatus pendingPlanChange cancelAtPeriodEnd cancelReason cancelRequestedAt planLimits';

const loadLibrary = async (libraryId) => {
    const lib = await Library.findOne({ _id: libraryId, isDeleted: false }).select(LIB_FIELDS).lean();
    if (!lib) throw new ApiError(404, 'Library not found');
    return lib;
};

const planBrief = (p, cycle) => (p ? {
    id: p._id, name: p.name, monthlyPrice: p.monthlyPrice, annualPrice: p.annualPrice,
    price: cycle ? L.planPrice(p, cycle) : undefined, features: p.features || [],
    limits: { maxStudents: p.maxStudents, maxSeats: p.maxSeats, maxStaff: p.maxStaff, maxBranches: p.maxBranches || 0 }
} : null);

/** GET /libraries/subscription */
exports.getSubscription = async (libraryId) => {
    const lib = await loadLibrary(libraryId);
    const plan = lib.subscriptionPlanId ? await PlatformPlan.findById(lib.subscriptionPlanId).lean() : null;
    const st = getSubscriptionState(lib, plan);
    const pending = lib.pendingPlanChange && lib.pendingPlanChange.platformPlanId
        ? await PlatformPlan.findById(lib.pendingPlanChange.platformPlanId).lean() : null;
    const cycle = lib.billingCycle || 'monthly';
    const running = ['active', 'trial'].includes(st.state);
    const entitlements = await entitlement.getEntitlements(libraryId, { library: lib, plan });
    return {
        plan: planBrief(plan, cycle) || { name: lib.subscriptionPlan },
        billingCycle: cycle,
        state: st.state,                         // trial | active | grace | expired
        subscriptionStatus: lib.subscriptionStatus || st.state,
        libraryStatus: lib.status,
        isTrial: st.state === 'trial',
        trialEndsAt: st.state === 'trial' ? st.expiresAt : (lib.subscriptionIsTrial ? lib.trialEndsAt : null),
        expiresAt: st.expiresAt,
        renewsOn: running && !lib.cancelAtPeriodEnd && st.state === 'active' ? st.expiresAt : null,
        endsOn: lib.cancelAtPeriodEnd ? st.expiresAt : null,
        graceEndsAt: st.state === 'grace' ? st.graceEndsAt : null,
        daysLeft: st.daysLeft,
        graceDaysLeft: st.graceDaysLeft,
        canWrite: st.canWrite,
        pendingPlanChange: lib.pendingPlanChange && lib.pendingPlanChange.platformPlanId ? {
            plan: planBrief(pending, lib.pendingPlanChange.billingCycle),
            billingCycle: lib.pendingPlanChange.billingCycle,
            effectiveAt: st.expiresAt,
            requestedAt: lib.pendingPlanChange.requestedAt,
            blockedReason: lib.pendingPlanChange.blockedReason || null
        } : null,
        cancelAtPeriodEnd: !!lib.cancelAtPeriodEnd,
        cancelReason: lib.cancelReason || null,
        entitlements                                  // { features, usage: { students|seats|staff|branches: { used, limit } } }
    };
};

/** Pure-ish planner shared by preview and execution; reads DB but writes nothing */
const planChange = async (libraryId, platformPlanId, billingCycle) => {
    const now = new Date();
    const lib = await loadLibrary(libraryId);
    const target = await PlatformPlan.findOne({ _id: platformPlanId, isActive: true, isDeleted: false }).lean();
    if (!target) throw new ApiError(404, 'Platform plan not found');
    const current = lib.subscriptionPlanId ? await PlatformPlan.findById(lib.subscriptionPlanId).lean() : null;
    const curCycle = lib.billingCycle || 'monthly';
    const st = getSubscriptionState(lib, current, now);
    const direction = L.classifyChange(current, curCycle, target, billingCycle);
    const running = st.state === 'active' && !lib.subscriptionIsTrial && lib.subscriptionExpiry && new Date(lib.subscriptionExpiry) > now;
    const usage = await entitlement.getUsage(libraryId);
    const violations = L.downgradeViolations(usage, target);
    const newPrice = L.planPrice(target, billingCycle);
    const base = {
        direction,
        current: { plan: planBrief(current, curCycle) || { name: lib.subscriptionPlan }, billingCycle: curCycle, state: st.state, expiresAt: st.expiresAt },
        target: { plan: planBrief(target, billingCycle), billingCycle, price: newPrice },
        usage, violations, blocked: violations.length > 0
    };
    if (direction === 'same') return { ...base, mode: 'none', lib, target, current };
    if (direction === 'downgrade' && running) {
        return { ...base, mode: 'scheduled', effectiveAt: lib.subscriptionExpiry, lib, target, current };
    }
    // immediate: upgrades, and any change when no running subscription exists (trial / grace / expired / unpaid)
    const periods = await subscription.paidPeriodsInForce(libraryId, now);
    const credit = running ? L.totalCredit(periods, now) : { credit: 0, unusedDays: 0, totalDays: 0 };
    const quote = L.upgradeQuote({ newPrice, credit: credit.credit });
    return {
        ...base, mode: 'immediate', effectiveAt: now,
        proration: { credit: quote.credit, unusedDays: credit.unusedDays, totalDays: credit.totalDays },
        amountDue: quote.amountDue, listPrice: quote.newPrice, lib, target, current
    };
};

const publicPlan = (r) => {
    const { lib, target, current, ...rest } = r;
    return rest;
};

const conflictFor = (violations) => {
    const e = new ApiError(409, `Your current usage exceeds the target plan limits: ${L.violationMessage(violations)}. Reduce usage before changing plans.`);
    e.errors = violations; // surfaced by the error middleware as `errors`
    return e;
};

/** POST /libraries/subscription/change-plan */
exports.changePlan = async ({ req, libraryId, platformPlanId, billingCycle, preview }) => {
    const r = await planChange(libraryId, platformPlanId, billingCycle);

    if (r.mode === 'none') {
        if (preview) return { applied: false, ...publicPlan(r), message: 'You are already on this plan and billing cycle' };
        if (r.lib.pendingPlanChange && r.lib.pendingPlanChange.platformPlanId) {
            await Library.updateOne({ _id: libraryId }, { $unset: { pendingPlanChange: '' } });
            audit(req, 'subscription.change.cancelled', 'Library', libraryId, { reason: 'reverted to current plan' });
            return { applied: false, cleared: true, message: 'Scheduled plan change removed', ...publicPlan(r) };
        }
        throw new ApiError(409, 'You are already on this plan and billing cycle');
    }
    if (preview) return { preview: true, ...publicPlan(r) };
    if (r.blocked) {
        audit(req, 'subscription.change.blocked', 'Library', libraryId, { direction: r.direction, violations: r.violations });
        throw conflictFor(r.violations);
    }

    if (r.mode === 'scheduled') {
        const res = await Library.updateOne(
            { _id: libraryId, isDeleted: false },
            { $set: { pendingPlanChange: { platformPlanId: r.target._id, billingCycle, requestedAt: new Date(), requestedBy: req.user._id } } }
        );
        if (!res.matchedCount) throw new ApiError(404, 'Library not found');
        audit(req, 'subscription.downgrade.scheduled', 'Library', libraryId,
            { from: r.current && r.current.name, to: r.target.name, billingCycle, effectiveAt: r.effectiveAt });
        return { applied: false, scheduled: true, effectiveAt: r.effectiveAt, ...publicPlan(r), message: 'Plan change scheduled for the end of the current period' };
    }

    // immediate
    // Free switch: a free target plan, or the proration credit covers the price. A remainder below the gateway
    // minimum (INR 1) cannot be charged, so it is waived; the library keeps its current expiry (the credit is not lost)
    // and the waived amount is recorded in the audit entry.
    const freeSwitch = r.listPrice <= 0 || r.amountDue < 1;
    if (freeSwitch) {
        const set = subscription.planSet(r.target, billingCycle);
        const unset = { pendingPlanChange: '' };
        if (r.listPrice <= 0) {
            // moving to a free plan with no running paid period: no expiry to track
            Object.assign(set, { subscriptionExpiry: null, trialEndsAt: null, subscriptionIsTrial: false, subscriptionStatus: 'active', cancelAtPeriodEnd: false });
        }
        await Library.updateOne({ _id: libraryId }, { $set: set, $unset: unset });
        audit(req, 'subscription.plan.changed', 'Library', libraryId,
            { from: r.current && r.current.name, to: r.target.name, billingCycle, charged: 0, credit: r.proration.credit, waivedAmount: Math.max(0, r.amountDue || 0) });
        return { applied: true, ...publicPlan(r), message: 'Plan changed' };
    }
    const order = await subscription.createOrder({
        libraryId, platformPlanId: r.target._id, period: billingCycle, userId: req.user._id,
        kind: 'upgrade', chargeAmount: r.amountDue, listPrice: r.listPrice, creditApplied: r.proration.credit
    });
    audit(req, 'subscription.upgrade.order', 'PlatformPayment', order.paymentRecordId,
        { from: r.current && r.current.name, to: r.target.name, billingCycle, amount: r.amountDue, credit: r.proration.credit });
    return { applied: false, order, ...publicPlan(r), message: 'Complete the payment to activate the new plan' };
};

/** POST /libraries/subscription/cancel (at period end, reversible) */
exports.cancel = async ({ req, libraryId, reason }) => {
    const lib = await loadLibrary(libraryId);
    const plan = lib.subscriptionPlanId ? await PlatformPlan.findById(lib.subscriptionPlanId).select('graceDays').lean() : null;
    const st = getSubscriptionState(lib, plan);
    if (!['active', 'trial'].includes(st.state) || !st.expiresAt) {
        throw new ApiError(409, 'There is no running subscription to cancel');
    }
    const res = await Library.updateOne(
        { _id: libraryId, cancelAtPeriodEnd: { $ne: true } },
        { $set: { cancelAtPeriodEnd: true, cancelReason: reason, cancelRequestedAt: new Date() } }
    );
    if (!res.modifiedCount) throw new ApiError(409, 'Cancellation is already scheduled');
    audit(req, 'subscription.cancel', 'Library', libraryId, { reason, endsOn: st.expiresAt });
    return { cancelAtPeriodEnd: true, endsOn: st.expiresAt };
};

/** POST /libraries/subscription/resume */
exports.resume = async ({ req, libraryId }) => {
    const res = await Library.updateOne(
        { _id: libraryId, cancelAtPeriodEnd: true },
        { $set: { cancelAtPeriodEnd: false }, $unset: { cancelReason: '', cancelRequestedAt: '' } }
    );
    if (!res.modifiedCount) {
        const lib = await loadLibrary(libraryId);
        if (lib.subscriptionStatus === 'cancelled') throw new ApiError(409, 'The subscription has already ended. Renew your plan to continue');
        throw new ApiError(409, 'No cancellation is scheduled');
    }
    audit(req, 'subscription.resume', 'Library', libraryId, {});
    return { cancelAtPeriodEnd: false };
};

exports._planChange = planChange; // exported for offline tests
