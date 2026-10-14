/**
 * Pure helpers for the SaaS subscription lifecycle (no DB access, easy to unit test).
 */
const { DAY_MS } = require('./time');
const { LIMITS, LIMIT_KEYS, effectiveLimit } = require('./features');

const SUSPEND_REASON = 'Subscription expired';
const CYCLES = ['monthly', 'annual'];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const addCycle = (from, cycle) => {
    const d = new Date(from);
    if (cycle === 'annual') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1);
    return d;
};

/** Price for a plan and cycle (annual falls back to 12x monthly when annualPrice is not set) */
const planPrice = (plan, cycle) => {
    if (!plan) return 0;
    if (cycle === 'annual') return plan.annualPrice > 0 ? plan.annualPrice : round2((plan.monthlyPrice || 0) * 12);
    return plan.monthlyPrice || 0;
};

const sameId = (a, b) => !!a && !!b && String(a._id || a) === String(b._id || b);

/** upgrade (immediate) | downgrade (period end) | same */
const classifyChange = (curPlan, curCycle, tgtPlan, tgtCycle) => {
    if (!curPlan) return 'upgrade';
    if (sameId(curPlan, tgtPlan)) {
        if (curCycle === tgtCycle) return 'same';
        return tgtCycle === 'annual' ? 'upgrade' : 'downgrade';
    }
    const cur = curPlan.monthlyPrice || 0;
    const tgt = tgtPlan.monthlyPrice || 0;
    if (tgt > cur) return 'upgrade';
    if (tgt < cur) return 'downgrade';
    const roomier = LIMIT_KEYS.every((k) => {
        const a = effectiveLimit(curPlan, k);
        const b = effectiveLimit(tgtPlan, k);
        return b === null || (a !== null && b >= a);
    });
    return roomier ? 'upgrade' : 'downgrade';
};

/**
 * Credit for unused time of one paid period. periodValue is the full price of that period (before any credit).
 * Whole unused days (ceil), clamped to [0, total].
 */
const prorationCredit = ({ periodValue, periodStart, periodEnd, now = new Date() }) => {
    if (!(periodValue > 0) || !periodStart || !periodEnd) return { credit: 0, unusedDays: 0, totalDays: 0 };
    const start = new Date(periodStart).getTime();
    const end = new Date(periodEnd).getTime();
    const t = new Date(now).getTime();
    const totalDays = Math.max(1, Math.round((end - start) / DAY_MS));
    const unusedDays = t <= start ? totalDays : Math.min(totalDays, Math.max(0, Math.ceil((end - t) / DAY_MS)));
    return { credit: round2(periodValue * unusedDays / totalDays), unusedDays, totalDays };
};

/** Sum credit over several paid periods that have not fully elapsed */
const totalCredit = (periods, now = new Date()) => {
    let credit = 0;
    let unusedDays = 0;
    let totalDays = 0;
    for (const p of periods) {
        if (new Date(p.periodEnd).getTime() <= new Date(now).getTime()) continue;
        const r = prorationCredit({ periodValue: p.periodValue, periodStart: p.periodStart, periodEnd: p.periodEnd, now });
        credit += r.credit;
        unusedDays += r.unusedDays;
        totalDays += r.totalDays;
    }
    return { credit: round2(credit), unusedDays, totalDays };
};

/** amount due for an upgrade: new period price minus credit, never negative */
const upgradeQuote = ({ newPrice, credit }) => {
    const c = Math.min(round2(credit), round2(newPrice));
    return { newPrice: round2(newPrice), credit: c, amountDue: round2(Math.max(0, newPrice - c)) };
};

/** Limits the target plan cannot hold given current usage. usage: {students, seats, staff, branches} */
const downgradeViolations = (usage, targetPlan) => {
    const out = [];
    for (const key of LIMIT_KEYS) {
        const limit = effectiveLimit(targetPlan, key);
        if (limit === null) continue;
        const used = usage[LIMITS[key].usage] || 0;
        if (used > limit) out.push({ limit: key, label: LIMITS[key].label, used, allowed: limit, excess: used - limit });
    }
    return out;
};

const violationMessage = (violations) =>
    violations.map((v) => `${v.label}: using ${v.used}, plan allows ${v.allowed}`).join('; ');

/** 7 | 3 | 1 | null for a library expiring at `expiry` */
const reminderStage = (expiry, now = new Date()) => {
    if (!expiry) return null;
    const ms = new Date(expiry).getTime() - new Date(now).getTime();
    if (ms <= 0) return null;
    const days = Math.ceil(ms / DAY_MS);
    if (days <= 1) return 1;
    if (days <= 3) return 3;
    if (days <= 7) return 7;
    return null;
};

const reminderKey = (expiry, stage) => `${new Date(expiry).getTime()}:${stage}`;

/** True if the reminder for (expiry, stage) was not sent yet. last = Library.lastReminderStage */
const shouldSendReminder = (last, expiry, stage) => {
    if (!stage) return false;
    if (!last) return true;
    const [exp, st] = String(last).split(':');
    if (Number(exp) !== new Date(expiry).getTime()) return true; // new period -> reminders restart
    return Number(st) > stage; // only move to a later (smaller) stage
};

module.exports = {
    SUSPEND_REASON, CYCLES, round2, addCycle, planPrice, classifyChange, prorationCredit, totalCredit, upgradeQuote,
    downgradeViolations, violationMessage, reminderStage, reminderKey, shouldSendReminder
};
