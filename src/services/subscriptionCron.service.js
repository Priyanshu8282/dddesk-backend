/**
 * Daily SaaS subscription lifecycle (spec 29), 02:00 IST:
 *   1. apply scheduled downgrades / cancellations whose period has ended
 *   2. trials & subscriptions past their end -> grace; past grace -> library suspended ("Subscription expired")
 *   3. renewal reminders at 7 / 3 / 1 days (once each, idempotent through Library.lastReminderStage)
 *
 * Every state change is a compare-and-set (the filter re-checks the expiry we read) so a payment that lands
 * mid-run wins and nothing is suspended or downgraded by mistake. A library suspended here carries
 * statusReason === SUSPEND_REASON, which is the marker a successful payment uses to reactivate it
 * (see subscription.service finalize).
 */
const cron = require('node-cron');
const Library = require('../models/library.model');
const PlatformPlan = require('../models/platformPlan.model');
const Admin = require('../models/admin.model');
const CronLock = require('../models/cronLock.model');
const GlobalSetting = require('../models/setting.model');
const systemAudit = require('../utils/systemAudit');
const L = require('../utils/subscriptionLifecycle');
const { istDateKey, DAY_MS } = require('../utils/time');
const { getSubscriptionState } = require('./subscriptionState.service');
const { invalidateAuthCacheForLibrary } = require('../middlewares/auth.middleware');

const TZ = { timezone: 'Asia/Kolkata' };
const MIN = 60 * 1000;
const LAST_RUN_KEY = 'cron:subscription-lifecycle:lastRun';
const BATCH = 200;

/** True while a maintenance window with "pause scheduled jobs" is active: the job is skipped (and logged), not failed. */
const pausedByMaintenance = async (name) => {
    try {
        if (await require('./maintenance.service').cronsPaused()) {
            console.log(`[cron] skipped ${name}: maintenance window active (jobs paused)`);
            return true;
        }
    } catch (_) { /* if the state cannot be read, run the job */ }
    return false;
};

const withLock = async (key, ttlMs, fn) => {
    if (await pausedByMaintenance(key.split(':')[0])) return;
    let got = false;
    try {
        got = await CronLock.acquire(key, ttlMs);
    } catch (e) {
        console.error(`[cron] lock error for ${key}:`, e.message);
        return;
    }
    if (!got) return;
    try {
        await fn();
    } catch (err) {
        console.error(`[cron] ${key} failed:`, err);
    }
};

const ownerIds = async (libraryId) => {
    const owners = await Admin.find({ libraryId, userType: 'admin', isDeleted: { $ne: true }, status: true }).select('_id').lean();
    return owners.map((o) => o._id);
};

const notifyOwners = async (event, libraryId, variables = {}, channels = ['inapp', 'push', 'email']) => {
    try {
        const { notifyEvent } = require('./notification.service');
        const ids = await ownerIds(libraryId);
        if (!ids.length) return;
        await notifyEvent(event, libraryId, { adminIds: ids, variables, channels, data: { event } });
    } catch (e) {
        console.error(`[subscription-cron] notify ${event} failed:`, e.message);
    }
};

const fmtDate = (d) => (d ? istDateKey(d) : '');

/** Async generator over libraries matching a filter, in batches (cursor by _id) */
async function* eachLibrary(filter, select) {
    let last = null;
    for (;;) {
        const q = last ? { ...filter, _id: { $gt: last } } : filter;
        const batch = await Library.find(q).select(select).sort({ _id: 1 }).limit(BATCH).lean();
        if (!batch.length) return;
        for (const lib of batch) yield lib;
        last = batch[batch.length - 1]._id;
    }
}

const planCache = () => {
    const m = new Map();
    return async (id) => {
        if (!id) return null;
        const k = String(id);
        if (!m.has(k)) m.set(k, await PlatformPlan.findById(id).lean());
        return m.get(k);
    };
};

/** 1. scheduled downgrades and cancellations whose period has ended */
const applyScheduledChanges = async (now = new Date()) => {
    const { planSet } = require('./subscription.service');
    const entitlement = require('./entitlement.service');
    const res = { downgraded: 0, cancelled: 0, blocked: 0 };
    const filter = {
        isDeleted: false, subscriptionExpiry: { $lte: now },
        $or: [{ 'pendingPlanChange.platformPlanId': { $exists: true } }, { cancelAtPeriodEnd: true }]
    };
    for await (const lib of eachLibrary(filter, 'subscriptionExpiry pendingPlanChange cancelAtPeriodEnd subscriptionPlan')) {
        const expiry = lib.subscriptionExpiry;
        if (lib.cancelAtPeriodEnd) {
            const r = await Library.updateOne(
                { _id: lib._id, cancelAtPeriodEnd: true, subscriptionExpiry: expiry },
                { $set: { subscriptionStatus: 'cancelled', cancelAtPeriodEnd: false }, $unset: { pendingPlanChange: '' } }
            );
            if (r.modifiedCount) {
                res.cancelled++;
                systemAudit(lib._id, 'subscription.cancel.applied', 'Library', lib._id, { endedOn: expiry });
            }
            continue;
        }
        const pending = lib.pendingPlanChange;
        if (!pending || !pending.platformPlanId) continue;
        const target = await PlatformPlan.findOne({ _id: pending.platformPlanId, isActive: true, isDeleted: false }).lean();
        if (!target) {
            await Library.updateOne({ _id: lib._id, 'pendingPlanChange.platformPlanId': pending.platformPlanId }, { $unset: { pendingPlanChange: '' } });
            systemAudit(lib._id, 'subscription.downgrade.dropped', 'Library', lib._id, { reason: 'target plan no longer available' });
            continue;
        }
        const usage = await entitlement.getUsage(lib._id);
        const violations = L.downgradeViolations(usage, target);
        if (violations.length) {
            const reason = L.violationMessage(violations);
            const r = await Library.updateOne(
                { _id: lib._id, 'pendingPlanChange.platformPlanId': pending.platformPlanId, 'pendingPlanChange.blockedReason': { $ne: reason } },
                { $set: { 'pendingPlanChange.blockedReason': reason } }
            );
            if (r.modifiedCount) systemAudit(lib._id, 'subscription.downgrade.blocked', 'Library', lib._id, { violations });
            res.blocked++;
            continue;
        }
        const r = await Library.updateOne(
            { _id: lib._id, subscriptionExpiry: expiry, 'pendingPlanChange.platformPlanId': pending.platformPlanId },
            { $set: planSet(target, pending.billingCycle || 'monthly'), $unset: { pendingPlanChange: '' } }
        );
        if (r.modifiedCount) {
            res.downgraded++;
            systemAudit(lib._id, 'subscription.downgrade.applied', 'Library', lib._id, { from: lib.subscriptionPlan, to: target.name });
        }
    }
    return res;
};

/** 2. trial/subscription ended -> grace; grace ended -> suspend (only if still unpaid: CAS on the expiry we read) */
const processLapsed = async (now = new Date()) => {
    const res = { graced: 0, suspended: 0 };
    const planOf = planCache();
    const filter = {
        isDeleted: false, status: 'active',
        $or: [{ subscriptionExpiry: { $lt: now } }, { subscriptionExpiry: null, trialEndsAt: { $lt: now } }]
    };
    const select = 'name subscriptionPlan subscriptionPlanId subscriptionExpiry trialEndsAt subscriptionIsTrial subscriptionStatus';
    for await (const lib of eachLibrary(filter, select)) {
        const plan = await planOf(lib.subscriptionPlanId);
        const st = getSubscriptionState(lib, plan, now);
        const same = { subscriptionExpiry: lib.subscriptionExpiry ?? null, trialEndsAt: lib.trialEndsAt ?? null };

        if (st.state === 'grace') {
            if (lib.subscriptionStatus === 'grace' || lib.subscriptionStatus === 'cancelled') continue;
            const r = await Library.updateOne(
                { _id: lib._id, status: 'active', subscriptionStatus: { $nin: ['grace', 'cancelled'] }, ...same },
                { $set: { subscriptionStatus: 'grace' } }
            );
            if (r.modifiedCount) {
                res.graced++;
                systemAudit(lib._id, 'subscription.grace.started', 'Library', lib._id, { endedOn: st.expiresAt, graceEndsAt: st.graceEndsAt, wasTrial: st.expiresAt && !lib.subscriptionExpiry });
                await notifyOwners('subscription-grace', lib._id, { graceEndsOn: fmtDate(st.graceEndsAt) });
            }
        } else if (st.state === 'expired') {
            const r = await Library.updateOne(
                { _id: lib._id, status: 'active', isDeleted: false, ...same },
                { $set: { status: 'suspended', statusReason: L.SUSPEND_REASON, subscriptionStatus: 'expired' } }
            );
            if (r.modifiedCount) {
                res.suspended++;
                invalidateAuthCacheForLibrary(lib._id);
                systemAudit(lib._id, 'subscription.suspended', 'Library', lib._id, { endedOn: st.expiresAt, graceEndedAt: st.graceEndsAt });
                await notifyOwners('subscription-suspended', lib._id);
                require('./platformAlerts.service').notify('subscriptionSuspended', {
                    message: `${lib.name || 'A library'} was suspended because its subscription ended and the grace period is over.`,
                    libraryId: lib._id, dedupeKey: String(lib._id), data: { libraryId: lib._id },
                });
            }
        }
    }
    return res;
};

/** 3. renewal reminders at 7/3/1 days before the end, once per stage */
const sendRenewalReminders = async (now = new Date()) => {
    const res = { sent: 0 };
    const horizon = new Date(now.getTime() + 7 * DAY_MS);
    const filter = {
        isDeleted: false, status: 'active', cancelAtPeriodEnd: { $ne: true },
        $or: [
            { subscriptionExpiry: { $gt: now, $lte: horizon } },
            { subscriptionExpiry: null, trialEndsAt: { $gt: now, $lte: horizon } }
        ]
    };
    for await (const lib of eachLibrary(filter, 'subscriptionPlan subscriptionExpiry trialEndsAt lastReminderStage')) {
        const expiry = lib.subscriptionExpiry || lib.trialEndsAt;
        const stage = L.reminderStage(expiry, now);
        if (!L.shouldSendReminder(lib.lastReminderStage, expiry, stage)) continue;
        const key = L.reminderKey(expiry, stage);
        const r = await Library.updateOne(
            { _id: lib._id, lastReminderStage: lib.lastReminderStage ?? null },
            { $set: { lastReminderStage: key } }
        );
        if (!r.modifiedCount) continue; // another instance claimed it
        res.sent++;
        await notifyOwners('subscription-expiring', lib._id, {
            daysLeft: Math.max(1, Math.ceil((new Date(expiry).getTime() - now.getTime()) / DAY_MS)),
            planName: lib.subscriptionPlan || 'subscription', expiryDate: fmtDate(expiry)
        });
    }
    return res;
};


const runSubscriptionLifecycle = async (now = new Date()) => {
    // first: finish any payment that was captured but never applied to its library
    const repairs = await require('./subscription.service').repairUnappliedPayments(now).catch((e) => {
        console.error('[subscription-cron] repair failed:', e.message);
        return { repaired: 0 };
    });
    const scheduled = await applyScheduledChanges(now);
    const lapsed = await processLapsed(now);
    const reminders = await sendRenewalReminders(now);
    const summary = { at: now, ...repairs, ...scheduled, ...lapsed, ...reminders };
    try {
        await GlobalSetting.findOneAndUpdate(
            { key: LAST_RUN_KEY },
            { $set: { value: summary, isPublic: false, description: 'Last run of the subscription lifecycle cron' } },
            { upsert: true }
        );
    } catch (e) { console.error('[subscription-cron] could not store last run:', e.message); }
    console.log('[cron] subscription lifecycle:', JSON.stringify(summary));
    return summary;
};

const initSubscriptionCronJobs = () => {
    // Daily 02:00 IST
    cron.schedule('0 2 * * *', () => {
        const day = istDateKey(new Date());
        return withLock(`subscription-lifecycle:${day}`, 23 * 60 * MIN, async () => {
            await runSubscriptionLifecycle();
        });
    }, TZ);
};

module.exports = {
    initSubscriptionCronJobs, runSubscriptionLifecycle, applyScheduledChanges, processLapsed, sendRenewalReminders, LAST_RUN_KEY
};
