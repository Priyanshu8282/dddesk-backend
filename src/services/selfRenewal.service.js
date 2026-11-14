/**
 * Student self-service renewal: pick a plan, optionally apply an offer, pay online, renewed.
 *
 *   options()  plans the student may renew to, the current membership and any unpaid renewal already started
 *   quote()    exact price (plan, offer discount, payable) and the new period; changes nothing
 *   start()    creates the renewal charge (offer applied) marked `pendingActivation`; the student then pays it
 *              through the normal Razorpay flow. Nothing about the membership changes yet.
 *   activatePaid()  called after every successful collection (online or at the desk) and by the recovery job:
 *              a pending renewal whose charge is fully paid is activated exactly once.
 *   cancel()   drops an unpaid renewal the student started; stale ones are dropped by the recovery job.
 *
 * The price is always computed here from the plan and the coupon, never taken from the app.
 */
const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const Student = require('../models/student.model');
const Plan = require('../models/plan.model');
const Payment = require('../models/payment.model');
const couponService = require('./coupon.service');
const planService = require('./plan.service');

const student = () => require('./student.service');
const internal = () => student()._internal;
const ledger = () => require('./feeLedger.service');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const STALE_AFTER_MS = 48 * 60 * 60 * 1000; // an unpaid self-renewal is dropped after 2 days

const planView = (p) => ({
    _id: String(p._id), name: p.name, description: p.description || '',
    durationDays: planService.getPlanDurationDays(p), durationType: p.durationType,
    price: r2(p.price), discount: r2(p.discount), finalPrice: r2(internal().planAmount(p)),
    shiftName: p.shiftName || null, shiftStart: p.shiftStart || null, shiftEnd: p.shiftEnd || null,
    features: p.features || [],
});

/** First day of the renewed period: the day after a running membership ends, otherwise today. */
const startDateFor = (s, now = new Date()) => (
    s.planStatus === 'active' && s.expiryDate && new Date(s.expiryDate) > now ? new Date(new Date(s.expiryDate).getTime() + 1) : now
);

const assertCanRenew = (s) => {
    if (s.isDeleted || s.status !== 'active') throw new ApiError(403, 'Your account is not active. Please contact the library.');
    if (s.planStatus === 'paused') throw new ApiError(400, 'Your membership is paused. Please ask the library to resume it first.');
    if (s.planStatus === 'pending') throw new ApiError(400, 'Your current plan is waiting for payment. Please pay it in Fees first.');
};

const renewablePlans = (libraryId) => Plan.find({
    libraryId, isDeleted: { $ne: true }, status: { $ne: false }, allowRenewal: { $ne: false },
}).sort({ finalPrice: 1, price: 1 }).lean();

/** The unpaid renewal this student already started, if any (one at a time). */
const openRenewal = (libraryId, studentId) => Payment.findOne({
    libraryId, studentId, 'pendingActivation.kind': 'renewal', paymentStatus: { $in: ['credit', 'partial', 'overdue'] },
}).sort({ createdAt: -1 });

const openView = (c) => c && ({
    chargeId: String(c._id), planId: String(c.pendingActivation.planId), amount: r2(c.totalAmount),
    due: r2(c.dueAmount), couponCode: c.couponCode || null, discount: r2(c.discountAmount || 0), createdAt: c.createdAt,
});

const options = async (studentId, libraryId) => {
    const s = await internal().loadStudent(studentId, libraryId);
    const [plans, open] = await Promise.all([renewablePlans(libraryId), openRenewal(libraryId, s._id)]);
    const current = s.planId ? await Plan.findOne({ _id: s.planId, libraryId }).lean() : null;
    let blockedReason = null;
    try { assertCanRenew(s); } catch (e) { blockedReason = e.message; }
    return {
        current: {
            plan: current ? planView(current) : null, planStatus: s.planStatus || 'none',
            expiryDate: s.expiryDate || null, renewable: current ? current.allowRenewal !== false && current.status !== false : false,
        },
        plans: plans.map(planView),
        startDate: startDateFor(s),
        openRenewal: openView(open),
        blockedReason,
    };
};

/** Price for `planId` with an optional offer. Throws a clear message for an offer that cannot be used. */
const quote = async (studentId, libraryId, { planId, couponCode }) => {
    const s = await internal().loadStudent(studentId, libraryId);
    assertCanRenew(s);
    const plan = await internal().loadPlan(planId, libraryId);
    if (plan.allowRenewal === false) throw new ApiError(400, `Plan "${plan.name}" cannot be renewed online. Please contact the library.`);
    const price = r2(internal().planAmount(plan));
    let discount = 0, coupon = null;
    if (couponCode && String(couponCode).trim()) {
        const v = await couponService.validateCoupon({ code: String(couponCode).trim().toUpperCase(), amount: price, planId: plan._id, studentId: s._id, libraryId });
        discount = r2(Math.min(price, Number(v?.discountAmount) || 0));
        coupon = { code: v.coupon.code, title: v.coupon.title || '', discount };
    }
    const window = internal().membershipWindow(plan, startDateFor(s));
    return { plan: planView(plan), price, discount, payable: r2(Math.max(0, price - discount)), coupon, startDate: window.start, endDate: window.end };
};

/**
 * Starts the renewal: one unpaid renewal at a time. Asking again for the same plan and offer returns the same bill
 * (a double tap or a retry never creates two); a different choice replaces the unpaid one.
 * A free renewal (nothing to pay) is activated at once.
 */
const start = async (studentId, libraryId, { planId, couponCode }, req) => {
    const q = await quote(studentId, libraryId, { planId, couponCode });
    const code = q.coupon ? q.coupon.code : null;
    const existing = await openRenewal(libraryId, studentId);
    if (existing) {
        const same = String(existing.pendingActivation.planId) === String(planId) && (existing.couponCode || null) === code;
        if (same) return { charge: openView(existing), quote: q, reused: true };
        if (r2(existing.paidAmount) > 0) throw new ApiError(409, 'You have already paid part of another renewal. Please finish paying it in Fees.');
        await ledger().rollbackCharge(libraryId, existing._id, 'Replaced by another renewal choice');
    }

    const s = await internal().loadStudent(studentId, libraryId);
    const plan = await internal().loadPlan(planId, libraryId);
    if (q.payable <= 0 && q.price <= 0) {
        // free plan: nothing to pay, renew now
        const r = await activateFor(s, plan, libraryId, req);
        return { charge: null, quote: q, activated: true, expiryDate: r.student.expiryDate };
    }
    const { charge } = await internal().createPlanCharge({
        libraryId, student: s, plan, amount: q.price, couponCode: code || undefined,
        dueDate: new Date(Date.now() + STALE_AFTER_MS), periodStart: q.startDate, periodEnd: q.endDate,
        paymentType: 'renewal', description: `${plan.name} renewal (online)`, req,
    });
    if (!charge) throw new ApiError(500, 'Could not create the renewal bill. Please try again.');
    await Payment.updateOne({ _id: charge._id }, { $set: { pendingActivation: { planId: plan._id, kind: 'renewal', requestedAt: new Date() } } });
    const fresh = await Payment.findById(charge._id);
    if (fresh.paymentStatus === 'paid') await activatePaid(libraryId, studentId); // a 100% offer settles it at once
    return { charge: openView(fresh) || { chargeId: String(fresh._id), amount: r2(fresh.totalAmount), due: 0 }, quote: q };
};

const activateFor = async (s, plan, libraryId, req) => {
    const { activateMembership } = student();
    const r = await activateMembership(s, plan, {
        libraryId, req, source: 'renewal', startDate: startDateFor(s), closeReason: 'renewed',
        paymentStatus: 'paid', paymentMethod: 'online',
    });
    internal().notifyMembership(libraryId, r.student, r.student.expiryDate);
    return r;
};

/** Activates every fully paid pending renewal of a student (or of everyone when studentId is omitted). Never throws. */
const activatePaid = async (libraryId, studentId) => {
    const filter = { 'pendingActivation.kind': 'renewal', paymentStatus: 'paid', 'pendingActivation.claimedAt': null };
    if (libraryId) filter.libraryId = libraryId;
    if (studentId) filter.studentId = studentId;
    const due = await Payment.find(filter).select('_id').limit(100).lean();
    let activated = 0;
    for (const { _id } of due) {
        // claim it: only one server (or one request) ever activates a renewal
        const c = await Payment.findOneAndUpdate({ _id, 'pendingActivation.claimedAt': null, paymentStatus: 'paid' }, { $set: { 'pendingActivation.claimedAt': new Date() } }, { new: true });
        if (!c) continue;
        try {
            const s = await Student.findOne({ _id: c.studentId, libraryId: c.libraryId });
            const plan = await Plan.findOne({ _id: c.pendingActivation.planId, libraryId: c.libraryId });
            if (!s || !plan) throw new Error('student or plan no longer exists');
            await activateFor(s, plan, c.libraryId);
            await Payment.updateOne({ _id: c._id }, { $unset: { pendingActivation: '' }, $set: { activatedAt: new Date() } });
            activated += 1;
        } catch (e) {
            // keep the money and the request; a person finishes it (the charge shows as paid with a note)
            await Payment.updateOne({ _id: c._id }, { $set: { 'pendingActivation.failedReason': String(e.message).slice(0, 300) } });
            console.error(`self-renewal activation failed for charge ${c._id}:`, e.message);
        }
    }
    return activated;
};

/** The student drops an unpaid renewal they started. */
const cancel = async (studentId, libraryId) => {
    const c = await openRenewal(libraryId, studentId);
    if (!c) return { cancelled: false };
    if (r2(c.paidAmount) > 0) throw new ApiError(409, 'Part of this renewal is already paid. Please contact the library.');
    await ledger().rollbackCharge(libraryId, c._id, 'Cancelled by the student');
    return { cancelled: true };
};

/** Recovery job: activate paid renewals that were missed, drop unpaid ones older than 2 days. */
const sweep = async (now = new Date()) => {
    const activated = await activatePaid(null, null);
    const stale = await Payment.find({
        'pendingActivation.kind': 'renewal', paymentStatus: { $in: ['credit', 'overdue'] }, paidAmount: { $lte: 0 },
        'pendingActivation.requestedAt': { $lt: new Date(now.getTime() - STALE_AFTER_MS) },
    }).select('_id libraryId').limit(200).lean();
    for (const c of stale) await ledger().rollbackCharge(c.libraryId, c._id, 'Online renewal not paid within 2 days');
    return { activated, dropped: stale.length };
};

module.exports = { options, quote, start, cancel, activatePaid, sweep, _startDateFor: startDateFor, _isValid: mongoose.Types.ObjectId.isValid };
