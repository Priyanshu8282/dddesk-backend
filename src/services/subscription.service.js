/**
 * SaaS subscription billing (library owner -> platform), spec 29.
 * Minimal but real: Razorpay order, verified payment extends library.subscriptionExpiry,
 * failed payments are recorded and open a grace window (PlatformPlan.graceDays).
 */
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const Library = require('../models/library.model');
const PlatformPlan = require('../models/platformPlan.model');
const PlatformPayment = require('../models/platformPayment.model');
const ReceiptCounter = require('../models/receiptCounter.model');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const { DAY_MS } = require('../utils/time');
const systemAudit = require('../utils/systemAudit');
const lifecycle = require('../utils/subscriptionLifecycle');
const { getSubscriptionState } = require('./subscriptionState.service');
const { SUSPEND_REASON, addCycle, planPrice } = lifecycle;

const PLATFORM_COUNTER_ID = new mongoose.Types.ObjectId('000000000000000000000001');

let _client = null;
const client = () => {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new ApiError(503, 'Online payments are not configured');
    if (!_client) _client = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    return _client;
};

const safeEqual = (a, b) => {
    const A = Buffer.from(String(a || ''), 'utf8');
    const B = Buffer.from(String(b || ''), 'utf8');
    return A.length > 0 && A.length === B.length && crypto.timingSafeEqual(A, B);
};

const addPeriod = addCycle;

// Indian financial year (April to March): 2026-27. GST invoices must be numbered in sequence within each FY.
const financialYear = (d = new Date()) => {
    const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
    const y = ist.getUTCFullYear();
    const startYear = ist.getUTCMonth() >= 3 ? y : y - 1; // April = month 3
    return { label: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`, startYear };
};
// One counter per FY: a stable ObjectId derived from the FY label
const fyCounterId = (label) => new mongoose.Types.ObjectId(require('crypto').createHash('md5').update(`platform-invoice:${label}`).digest('hex').slice(0, 24));

const nextInvoiceNo = async () => {
    const fy = financialYear();
    const id = fyCounterId(fy.label);
    let c = await ReceiptCounter.findOneAndUpdate({ libraryId: id }, { $inc: { seq: 1 } }, { new: true });
    if (!c) {
        try { c = await ReceiptCounter.create({ libraryId: id, seq: 1 }); } catch (e) {
            if (e.code !== 11000) throw e;
            c = await ReceiptCounter.findOneAndUpdate({ libraryId: id }, { $inc: { seq: 1 } }, { new: true });
        }
    }
    return `INV/${fy.label}/${String(c.seq).padStart(6, '0')}`;
};
exports.financialYear = financialYear;

/** GST on top of a price that excludes it. All values rounded to paise. */
const withGst = (taxable, gstPercent) => {
    const t = Math.round((Number(taxable) + Number.EPSILON) * 100) / 100;
    const pct = Number.isFinite(Number(gstPercent)) ? Number(gstPercent) : 18;
    const gst = Math.round((t * pct / 100 + Number.EPSILON) * 100) / 100;
    return { taxable: t, gstPercent: pct, gst, total: Math.round((t + gst + Number.EPSILON) * 100) / 100 };
};
exports.withGst = withGst;

/** active | grace | expired | none, with the grace window if one applies */
const subscriptionState = (library, plan, lastFailed) => {
    const now = Date.now();
    const expiry = library.subscriptionExpiry ? new Date(library.subscriptionExpiry) : null;
    if (!expiry) return { state: 'none', expiry: null, graceUntil: null, inGrace: false };
    const graceDays = plan && plan.graceDays != null ? plan.graceDays : 0;
    const graceUntil = new Date(expiry.getTime() + graceDays * DAY_MS);
    if (expiry.getTime() >= now) return { state: 'active', expiry, graceUntil, inGrace: false, paymentFailed: !!lastFailed };
    if (graceUntil.getTime() >= now) return { state: 'grace', expiry, graceUntil, inGrace: true, paymentFailed: !!lastFailed };
    return { state: 'expired', expiry, graceUntil, inGrace: false, paymentFailed: !!lastFailed };
};

exports.subscriptionState = subscriptionState;

const clampPaging = (q = {}) => ({
    page: Math.max(1, parseInt(q.page, 10) || 1),
    limit: Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20))
});

exports.listPayments = async (libraryId, query = {}) => {
    const { page, limit } = clampPaging(query);
    const filter = { libraryId };
    if (query.status) filter.status = String(query.status);
    // Additive optional filters (owner payment history)
    if (query.period && ['monthly', 'annual'].includes(String(query.period))) filter.period = String(query.period);
    if (query.kind && ['renewal', 'upgrade'].includes(String(query.kind))) filter.kind = String(query.kind);
    if (query.q) filter.invoiceNo = new RegExp(require('../utils/escapeRegex')(String(query.q).slice(0, 40)), 'i');
    const fromD = query.from ? new Date(`${String(query.from).slice(0, 10)}T00:00:00+05:30`) : null;
    const toD = query.to ? new Date(`${String(query.to).slice(0, 10)}T23:59:59.999+05:30`) : null;
    if ((fromD && !Number.isNaN(fromD.getTime())) || (toD && !Number.isNaN(toD.getTime()))) {
        filter.createdAt = {};
        if (fromD && !Number.isNaN(fromD.getTime())) filter.createdAt.$gte = fromD;
        if (toD && !Number.isNaN(toD.getTime())) filter.createdAt.$lte = toD;
    }
    const [data, total, library] = await Promise.all([
        PlatformPayment.find(filter).populate('platformPlanId', 'name slug').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        PlatformPayment.countDocuments(filter),
        Library.findById(libraryId).select('name subscriptionPlan subscriptionPlanId subscriptionExpiry').lean()
    ]);
    const plan = library && library.subscriptionPlanId ? await PlatformPlan.findById(library.subscriptionPlanId).lean() : null;
    const lastFailed = await PlatformPayment.findOne({ libraryId }).sort({ createdAt: -1 }).lean();
    return {
        data, total, page, limit, totalPages: Math.ceil(total / limit),
        subscription: library ? {
            plan: library.subscriptionPlan,
            ...subscriptionState(library, plan, lastFailed && lastFailed.status === 'failed')
        } : null
    };
};

/** Super admin: every library with its subscription state + last payment */
exports.listSubscriptions = async (query = {}) => {
    const { page, limit } = clampPaging(query);
    const filter = { isDeleted: false };
    if (query.search) filter.name = new RegExp(require('../utils/escapeRegex')(String(query.search)), 'i');
    const libs = await Library.find(filter).select('name subscriptionPlan subscriptionPlanId subscriptionExpiry status')
        .sort({ createdAt: -1 }).lean();
    const plans = await PlatformPlan.find({}).lean();
    const planMap = new Map(plans.map((p) => [String(p._id), p]));
    const last = await PlatformPayment.aggregate([
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$libraryId', status: { $first: '$status' }, amount: { $first: '$amount' }, at: { $first: '$createdAt' }, inGrace: { $first: '$inGrace' } } }
    ]);
    const lastMap = new Map(last.map((l) => [String(l._id), l]));
    let rows = libs.map((l) => {
        const lp = lastMap.get(String(l._id));
        const st = subscriptionState(l, l.subscriptionPlanId ? planMap.get(String(l.subscriptionPlanId)) : null, lp && lp.status === 'failed');
        return {
            libraryId: l._id, name: l.name, libraryStatus: l.status, plan: l.subscriptionPlan,
            ...st, lastPayment: lp ? { status: lp.status, amount: lp.amount, at: lp.at } : null
        };
    });
    if (query.state) rows = rows.filter((r) => r.state === query.state);
    const total = rows.length;
    return { data: rows.slice((page - 1) * limit, page * limit), total, page, limit, totalPages: Math.ceil(total / limit) };
};

/** Paid periods that have not fully elapsed (used for proration credit) */
const paidPeriodsInForce = async (libraryId, now = new Date()) => {
    const rows = await PlatformPayment.find({ libraryId, status: 'paid', periodEnd: { $gt: now } }).lean();
    return rows.map((r) => ({
        periodStart: r.periodStart, periodEnd: r.periodEnd,
        periodValue: r.listPrice != null ? r.listPrice : r.amount
    }));
};

exports.paidPeriodsInForce = paidPeriodsInForce;

/** Plans an owner can choose from: active only, with GST worked out per billing cycle */
exports.listAvailablePlans = async () => {
    const plans = await PlatformPlan.find({ isDeleted: false, isActive: true }).sort({ sortOrder: 1, monthlyPrice: 1 }).lean();
    return plans.map((p) => {
        const monthly = withGst(planPrice(p, 'monthly'), p.gstPercent);
        const annual = withGst(planPrice(p, 'annual'), p.gstPercent);
        return {
            _id: p._id, name: p.name, slug: p.slug, description: p.description, isPopular: !!p.isPopular,
            gstPercent: monthly.gstPercent, trialDays: p.trialDays,
            limits: { maxStudents: p.maxStudents, maxSeats: p.maxSeats, maxStaff: p.maxStaff, maxBranches: p.maxBranches || 0 },
            features: p.features || [],
            monthly: { price: monthly.taxable, gst: monthly.gst, total: monthly.total },
            annual: { price: annual.taxable, gst: annual.gst, total: annual.total, savingsVsMonthly: Math.max(0, Math.round((planPrice(p, 'monthly') * 12 - planPrice(p, 'annual')) * 100) / 100) },
        };
    });
};

/**
 * Create a Razorpay order. kind 'renewal' (default) extends the current period; kind 'upgrade' is an immediate
 * plan change: chargeAmount = new price minus prorated credit, listPrice = full price, new period starts at payment.
 */
exports.createOrder = async ({ libraryId, platformPlanId, period, userId, kind = 'renewal', chargeAmount, listPrice, creditApplied = 0 }) => {
    const library = await Library.findById(libraryId).select('subscriptionPlanId billingCycle subscriptionExpiry subscriptionIsTrial');
    if (!library) throw new ApiError(404, 'Library not found');
    const planId = platformPlanId || library.subscriptionPlanId;
    if (!planId || !mongoose.isValidObjectId(planId)) throw new ApiError(400, 'platformPlanId is required');
    const plan = await PlatformPlan.findOne({ _id: planId, isActive: true, isDeleted: false });
    if (!plan) throw new ApiError(404, 'Platform plan not found');
    const cycle = period || library.billingCycle || 'monthly';
    if (!['monthly', 'annual'].includes(cycle)) throw new ApiError(400, 'period must be monthly or annual');

    // Switching plans while a paid/running subscription exists must go through change-plan (proration, downgrade rules)
    if (kind === 'renewal' && library.subscriptionPlanId && String(library.subscriptionPlanId) !== String(plan._id)
        && !library.subscriptionIsTrial && library.subscriptionExpiry && new Date(library.subscriptionExpiry) > new Date()) {
        throw new ApiError(409, 'To switch plans use POST /libraries/subscription/change-plan');
    }

    const price = planPrice(plan, cycle);
    const taxableBase = chargeAmount != null ? chargeAmount : price;
    if (!(taxableBase > 0)) throw new ApiError(400, 'This plan is free; no payment is required');
    // The plan price excludes GST: Razorpay is charged price + GST, and the breakdown is stored for the invoice
    const tax = withGst(taxableBase, plan.gstPercent);
    const amount = tax.total;

    const rz = client();
    const record = await PlatformPayment.create({
        libraryId, platformPlanId: plan._id, period: cycle, amount, kind,
        taxableAmount: tax.taxable, gstPercent: tax.gstPercent, gstAmount: tax.gst,
        listPrice: listPrice != null ? listPrice : price, creditApplied, status: 'pending', initiatedBy: userId
    });
    let order;
    try {
        order = await rz.orders.create({
            amount: Math.round(amount * 100), currency: 'INR', receipt: `sub_${record._id}`,
            notes: { platformPaymentId: String(record._id), libraryId: String(libraryId), kind }
        });
    } catch (e) {
        record.status = 'failed';
        record.failureReason = `Order creation failed: ${(e && e.message) || 'gateway error'}`;
        await record.save();
        throw new ApiError(502, 'Could not create the payment order. Please try again');
    }
    record.razorpayOrderId = order.id;
    await record.save();
    return {
        orderId: order.id, paymentRecordId: record._id, amount: order.amount, amountInr: amount, currency: 'INR',
        key: process.env.RAZORPAY_KEY_ID, plan: { id: plan._id, name: plan.name }, period: cycle, billingCycle: cycle, kind,
        taxableAmount: tax.taxable, gstPercent: tax.gstPercent, gstAmount: tax.gst, totalAmount: tax.total,
        listPrice: record.listPrice, creditApplied
    };
};

const markFailed = async (record, reason) => {
    const plan = await PlatformPlan.findById(record.platformPlanId).lean();
    const lib = await Library.findById(record.libraryId).select('subscriptionExpiry').lean();
    const base = lib && lib.subscriptionExpiry && new Date(lib.subscriptionExpiry) > new Date() ? new Date(lib.subscriptionExpiry) : new Date();
    const graceUntil = new Date(base.getTime() + ((plan && plan.graceDays) || 0) * DAY_MS);
    require('./platformAlerts.service').notify('paymentFailed', {
        message: `A subscription payment of INR ${record.amount} failed${plan ? ' for the ' + plan.name + ' plan' : ''}. Reason: ${reason}`,
        libraryId: record.libraryId, dedupeKey: String(record._id), data: { libraryId: record.libraryId },
    });
    return PlatformPayment.findOneAndUpdate(
        { _id: record._id, status: { $ne: 'paid' } },
        { $set: { status: 'failed', failureReason: reason, graceUntil, inGrace: graceUntil.getTime() > Date.now() } },
        { new: true }
    );
};

/** Fields copied from a plan onto the library (entitlement snapshot) */
const planSet = (plan, cycle) => ({
    subscriptionPlan: plan.name,
    subscriptionPlanId: plan._id,
    billingCycle: cycle,
    'planLimits.maxStudents': plan.maxStudents,
    'planLimits.maxSeats': plan.maxSeats,
    'planLimits.maxStaff': plan.maxStaff,
    'planLimits.maxBranches': plan.maxBranches || 0
});
exports.planSet = planSet;

/** Reactivate a library that THIS lifecycle suspended (atomic; ignores manual suspensions by the super admin) */
const reinstateIfSuspendedForNonPayment = async (libraryId, paymentId) => {
    const r = await Library.updateOne(
        { _id: libraryId, status: 'suspended', statusReason: SUSPEND_REASON, isDeleted: false },
        { $set: { status: 'active', statusReason: null, subscriptionStatus: 'active' } }
    );
    if (r.modifiedCount) {
        systemAudit(libraryId, 'subscription.reinstated', 'Library', libraryId, { paymentId: String(paymentId) });
        try {
            const { notifyEvent } = require('./notification.service');
            const Admin = require('../models/admin.model');
            const owners = await Admin.find({ libraryId, userType: 'admin', isDeleted: { $ne: true }, status: true }).select('_id').lean();
            await notifyEvent('subscription-reinstated', libraryId, { adminIds: owners.map((o) => o._id), channels: ['inapp', 'push'] });
        } catch (e) { console.error('[subscription] reinstate notify failed:', e.message); }
    }
    return !!r.modifiedCount;
};

const finalize = async (record, paymentId, signature) => {
    const claimed = await PlatformPayment.findOneAndUpdate(
        { _id: record._id, status: { $in: ['pending', 'failed'] } },
        { $set: { status: 'paid', razorpayPaymentId: paymentId, razorpaySignature: signature, paidAt: new Date(), inGrace: false, failureReason: undefined } },
        { new: true }
    );
    if (!claimed) return PlatformPayment.findById(record._id); // already settled (idempotent)

    const plan = await PlatformPlan.findById(claimed.platformPlanId).lean();
    const lib = await Library.findById(claimed.libraryId).select('subscriptionExpiry');
    const now = new Date();
    // renewal extends the current period; an upgrade starts a fresh period now (unused time was credited in the price)
    const startFrom = claimed.kind !== 'upgrade' && lib && lib.subscriptionExpiry && new Date(lib.subscriptionExpiry) > now
        ? new Date(lib.subscriptionExpiry) : now;
    const periodEnd = addPeriod(startFrom, claimed.period);
    claimed.periodStart = startFrom;
    claimed.periodEnd = periodEnd;
    claimed.invoiceNo = await nextInvoiceNo();
    claimed.graceUntil = undefined;
    await claimed.save();

    const set = {
        subscriptionExpiry: periodEnd, subscriptionPlanId: claimed.platformPlanId, subscriptionIsTrial: false,
        billingCycle: claimed.period, subscriptionStatus: 'active', cancelAtPeriodEnd: false
    };
    if (plan) Object.assign(set, planSet(plan, claimed.period));
    const update = { $set: set, $unset: { cancelReason: '', cancelRequestedAt: '', lastReminderStage: '' } };
    if (claimed.kind === 'upgrade') update.$unset.pendingPlanChange = '';
    await Library.updateOne({ _id: claimed.libraryId }, update);
    if (claimed.kind !== 'upgrade') {
        // a scheduled change to the plan just paid for is moot
        await Library.updateOne(
            { _id: claimed.libraryId, 'pendingPlanChange.platformPlanId': claimed.platformPlanId, 'pendingPlanChange.billingCycle': claimed.period },
            { $unset: { pendingPlanChange: '' } }
        );
    }
    await reinstateIfSuspendedForNonPayment(claimed.libraryId, claimed._id);
    return claimed;
};

exports.verifyPayment = async ({ libraryId, orderId, paymentId, signature, req }) => {
    if (!process.env.RAZORPAY_KEY_SECRET) throw new ApiError(503, 'Online payments are not configured');
    const record = await PlatformPayment.findOne({ razorpayOrderId: String(orderId), libraryId });
    if (!record) throw new ApiError(404, 'Subscription order not found');
    if (record.status === 'paid') {
        if (record.razorpayPaymentId && record.razorpayPaymentId !== paymentId) throw new ApiError(409, 'Order already paid with a different payment');
        return { payment: record, alreadyProcessed: true };
    }
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    if (!safeEqual(expected, signature)) {
        await markFailed(record, 'Invalid payment signature');
        if (req) audit(req, 'subscription.payment.failed', 'PlatformPayment', record._id, { reason: 'signature' });
        throw new ApiError(400, 'Payment verification failed - invalid signature');
    }
    const payment = await finalize(record, paymentId, signature);
    if (req) audit(req, 'subscription.payment.paid', 'PlatformPayment', record._id, { amount: record.amount, invoiceNo: payment.invoiceNo });
    return { payment, alreadyProcessed: false };
};

// webhook entry points (signature already verified by the controller)
exports.handleCaptured = async (pay) => {
    const record = await PlatformPayment.findOne({ razorpayOrderId: pay.order_id });
    if (!record) return;
    if (record.status === 'paid') return;
    if (pay.amount !== Math.round(record.amount * 100)) {
        await markFailed(record, 'Captured amount does not match the order');
        return;
    }
    await finalize(record, pay.id, undefined);
};

exports.handleFailed = async (pay) => {
    const record = await PlatformPayment.findOne({ razorpayOrderId: pay.order_id });
    if (!record || record.status === 'paid') return;
    await markFailed(record, pay.error_description || 'Payment failed at gateway');
};
