/**
 * Fee ledger.
 *
 *  Charge      = Payment document (totalAmount, dueDate, paidAmount, dueAmount, paymentStatus ...)
 *  Receipt     = PaymentTransaction (type 'collection') holding allocations to charges
 *  Allocation  = mirrored on both sides (txn.allocations[].paymentId, charge.allocations[].transactionId)
 *
 * All charge mutations go through document.save() so the Payment pre-save hook always recomputes
 * dueAmount/status; optimisticConcurrency on the schema + retry protects concurrent updates.
 */
const mongoose = require('mongoose');
const Payment = require('../models/payment.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const ReceiptCounter = require('../models/receiptCounter.model');
const Student = require('../models/student.model');
const Plan = require('../models/plan.model');
const Library = require('../models/library.model');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const couponService = require('./coupon.service');
const { endOfDayIST, startOfDayIST, istDateKey, DAY_MS } = require('../utils/time');
const { fiscalYearKey, computeGst } = require('../utils/feeMath');

const OPEN_STATUSES = ['credit', 'partial', 'overdue'];
const TERMINAL_STATUSES = ['cancelled', 'refunded'];
const EPS = 0.009;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => mongoose.isValidObjectId(v);
const monthKey = (d) => {
    const x = new Date(d || Date.now());
    const ist = new Date(x.getTime() + 330 * 60 * 1000);
    return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
};

const validAmount = (amount, label = 'amount') => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, `${label} must be a positive number`);
    if (Math.abs(r2(n) - n) > 1e-9) throw new ApiError(400, `${label} may have at most 2 decimal places`);
    return r2(n);
};

// ── permissions / audit helpers ───────────────────────────────────────────────
const PERM_KEYS = {
    refund: ['fees.refund', 'FEES_REFUND', 'REFUND_PAYMENT'],
    adjust: ['fees.adjust', 'fees.refund', 'FEES_ADJUST', 'ADJUST_PAYMENT'],
    allocate: ['fees.allocate', 'fees.adjust', 'FEES_ALLOCATE', 'FEES_ADJUST']
};

const hasPermission = (req, keys) => {
    if (!req || !req.userType) return true; // internal/system call
    if (req.userType === 'admin' || req.userType === 'superadmin') return true;
    if (req.userType === 'staff') return keys.some((k) => (req.permissions || []).includes(k));
    return false;
};

const assertPermission = (req, keys) => {
    if (!hasPermission(req, keys)) throw new ApiError(403, 'You do not have permission to perform this action');
};

const auditEvent = (req, libraryId, fallbackUserId, action, resource, resourceId, metadata) => {
    const r = req && req.user
        ? req
        : { libraryId, user: { _id: fallbackUserId }, userType: 'system', ip: 'system', headers: {} };
    return audit(r, action, resource, resourceId, metadata);
};

const notifyLater = (fn) => {
    try { setImmediate(() => { Promise.resolve().then(fn).catch((e) => console.error('[feeLedger] notify failed:', e.message)); }); } catch (e) { /* ignore */ }
};

// ── library policy ────────────────────────────────────────────────────────────
const DEFAULT_POLICY = {
    allowCredit: true,
    maxCreditAmount: 0,
    maxCreditDays: 0,
    graceDays: 0,
    reminderFrequencyDays: 3,
    blockAfterDue: false
};

const getPolicy = async (libraryId) => {
    const lib = await Library.findById(libraryId).select('feePolicy receipt name').lean();
    return { ...DEFAULT_POLICY, ...((lib && lib.feePolicy) || {}) };
};

const isChargeOverdue = (charge, graceDays = 0, now = new Date()) => {
    if (!charge.dueDate || !(charge.dueAmount > 0)) return false;
    return endOfDayIST(charge.dueDate).getTime() + (graceDays || 0) * DAY_MS < now.getTime();
};

// ── receipt numbers ───────────────────────────────────────────────────────────
/**
 * Receipt numbers are sequential per library per Indian financial year (Apr-Mar IST): RCPT-2627-000001,
 * refunds RCPT-R-2627-000001. The first financial year after this scheme went live continues the old
 * single sequence (legacy `seq`), so numbering never restarts mid-year; later years restart at 1.
 */
const nextReceiptNo = async (libraryId, kind = 'receipt', when = new Date()) => {
    const lib = await Library.findById(libraryId).select('receipt').lean();
    const fy = fiscalYearKey(when);
    const path = `fySeq.${fy}`;
    let c = await ReceiptCounter.findOneAndUpdate({ libraryId, [path]: { $exists: true } }, { $inc: { [path]: 1 } }, { new: true });
    if (!c) {
        // First receipt of this financial year: initialise its sequence (atomic; a concurrent initialiser wins harmlessly)
        const doc = await ReceiptCounter.findOne({ libraryId }).lean();
        const hasAnyFy = !!(doc && doc.fySeq && Object.keys(doc.fySeq).length);
        const configured = Math.max(1, (lib && lib.receipt && lib.receipt.nextNumber) || 1);
        const base = doc ? (hasAnyFy ? 0 : doc.seq || 0) : configured - 1;
        try {
            await ReceiptCounter.updateOne({ libraryId, [path]: { $exists: false } }, { $set: { [path]: base } }, { upsert: true });
        } catch (e) {
            if (e.code !== 11000) throw e;
        }
        c = await ReceiptCounter.findOneAndUpdate({ libraryId, [path]: { $exists: true } }, { $inc: { [path]: 1 } }, { new: true });
    }
    const seq = c.fySeq[fy];
    const prefix = (lib && lib.receipt && lib.receipt.prefix) || 'RCPT';
    return `${prefix}-${kind === 'refund' ? 'R-' : ''}${fy}-${String(seq).padStart(6, '0')}`;
};

// ── outstanding ───────────────────────────────────────────────────────────────
const outstandingFor = async (libraryId, studentId, policy) => {
    const now = new Date();
    const charges = await Payment.find({
        libraryId,
        studentId,
        paymentStatus: { $in: OPEN_STATUSES },
        dueAmount: { $gt: 0 }
    }).sort({ dueDate: 1, createdAt: 1 }).lean();

    let total = 0;
    let overdueCount = 0;
    const out = charges.map((c) => {
        total += c.dueAmount;
        const overdue = isChargeOverdue(c, policy.graceDays, now);
        if (overdue) overdueCount += 1;
        return {
            ...c,
            isOverdue: overdue,
            daysOverdue: overdue ? Math.max(0, Math.floor((now - endOfDayIST(c.dueDate)) / DAY_MS)) : 0
        };
    });
    return {
        totalOutstanding: r2(total),
        charges: out,
        overdueCount,
        blocked: !!policy.blockAfterDue && overdueCount > 0, // advisory only, never auto-blocks
        policy: {
            allowCredit: policy.allowCredit,
            maxCreditAmount: policy.maxCreditAmount,
            maxCreditDays: policy.maxCreditDays,
            graceDays: policy.graceDays,
            blockAfterDue: policy.blockAfterDue
        }
    };
};

const getOutstanding = async (libraryId, studentId) => {
    const policy = await getPolicy(libraryId);
    return outstandingFor(libraryId, studentId, policy);
};

/** Library-wide outstanding summary, one row per student with dues. */
// `scope` = branch filter fragment from utils/branchScope.branchFilter(req) ({} = all branches)
const OUTSTANDING_SORTS = {
    amount: { totalOutstanding: -1 },
    oldest: { oldestDueDate: 1, totalOutstanding: -1 },
    name: { name: 1 }
};

const getLibraryOutstanding = async (libraryId, { overdueOnly = false, page = 1, limit = 20, search, scope = {}, sort } = {}) => {
    const policy = await getPolicy(libraryId);
    const match = { libraryId: oid(libraryId), paymentStatus: { $in: OPEN_STATUSES }, dueAmount: { $gt: 0 }, ...scope };
    if (overdueOnly) {
        match.dueDate = { $lt: startOfDayIST(new Date(Date.now() - (policy.graceDays || 0) * DAY_MS)) };
    }
    const pipeline = [
        { $match: match },
        { $group: { _id: '$studentId', totalOutstanding: { $sum: '$dueAmount' }, charges: { $sum: 1 }, oldestDueDate: { $min: '$dueDate' } } },
        { $lookup: { from: 'students', localField: '_id', foreignField: '_id', as: 'student' } },
        { $unwind: '$student' },
        { $match: { 'student.isDeleted': { $ne: true } } }
    ];
    if (search) {
        const rx = new RegExp(require('../utils/escapeRegex')(String(search).trim()), 'i');
        pipeline.push({ $match: { $or: [{ 'student.name': rx }, { 'student.mobile': rx }] } });
    }
    pipeline.push({
        $project: {
            _id: 0, studentId: '$_id', totalOutstanding: 1, charges: 1, oldestDueDate: 1,
            name: '$student.name', mobile: '$student.mobile', rollNumber: '$student.rollNumber'
        }
    });
    const skip = (Math.max(1, page) - 1) * limit;
    const [res] = await Payment.aggregate([
        ...pipeline,
        { $sort: OUTSTANDING_SORTS[sort] || OUTSTANDING_SORTS.amount },
        { $facet: {
            rows: [{ $skip: skip }, { $limit: limit }],
            meta: [{ $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalOutstanding' } } }]
        } }
    ]);
    const meta = (res.meta && res.meta[0]) || { count: 0, total: 0 };
    return {
        data: res.rows,
        total: meta.count,
        page,
        limit,
        totalPages: Math.ceil(meta.count / limit),
        totalOutstanding: r2(meta.total)
    };
};

// ── credit policy ─────────────────────────────────────────────────────────────
const enforceCreditPolicy = async ({ libraryId, studentId, newDue, paidNow = 0, dueDate, policy }) => {
    if (!(newDue > EPS)) return;
    const p = policy || await getPolicy(libraryId);
    if (!p.allowCredit && paidNow <= 0) {
        throw new ApiError(400, 'This library does not allow credit: payment is required at the time of joining/billing');
    }
    if (p.maxCreditAmount > 0 || p.maxCreditDays > 0) {
        const out = await outstandingFor(libraryId, studentId, p);
        if (p.maxCreditAmount > 0 && out.totalOutstanding + newDue > p.maxCreditAmount + EPS) {
            throw new ApiError(400, `Credit limit exceeded: outstanding would be ₹${r2(out.totalOutstanding + newDue)} (max ₹${p.maxCreditAmount})`);
        }
        if (p.maxCreditDays > 0) {
            if (dueDate) {
                const span = Math.ceil((new Date(dueDate).getTime() - Date.now()) / DAY_MS);
                if (span > p.maxCreditDays) throw new ApiError(400, `Due date exceeds the maximum credit period of ${p.maxCreditDays} day(s)`);
            }
            const oldest = out.charges.reduce((m, c) => (!m || c.createdAt < m ? c.createdAt : m), null);
            if (oldest && Math.floor((Date.now() - new Date(oldest).getTime()) / DAY_MS) > p.maxCreditDays) {
                throw new ApiError(400, `Existing dues are older than the maximum credit period of ${p.maxCreditDays} day(s). Clear them first`);
            }
        }
    }
};

// ── idempotency + student payment flag ────────────────────────────────────────
const cleanRequestKey = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const k = String(v).trim();
    if (!/^[A-Za-z0-9_.:-]{8,100}$/.test(k)) throw new ApiError(400, 'Idempotency key must be 8-100 characters (letters, digits, _ . : -)');
    return k;
};

const totalDueOf = async (libraryId, studentId) => {
    const [row] = await Payment.aggregate([
        { $match: { libraryId: oid(libraryId), studentId: oid(studentId), paymentStatus: { $in: OPEN_STATUSES }, dueAmount: { $gt: 0 } } },
        { $group: { _id: null, due: { $sum: '$dueAmount' } } }
    ]);
    return r2(row ? row.due : 0);
};

/** Recompute Student.paymentStatus from the live ledger (call after anything that changes dues). Returns the total due. */
const refreshStudentPaymentStatus = async (libraryId, studentId) => {
    const due = await totalDueOf(libraryId, studentId);
    try {
        await Student.updateOne({ _id: studentId, libraryId }, { $set: { paymentStatus: due <= EPS ? 'paid' : 'pending' } });
    } catch (e) {
        console.error('[feeLedger] could not refresh student paymentStatus:', e.message);
    }
    return due;
};

/** The collection already recorded for an idempotency key, or null. Throws 409 on key reuse / in-flight request. */
const findCollectionByRequestId = async (libraryId, key) => {
    const k = cleanRequestKey(key);
    if (!k) return null;
    return PaymentTransaction.findOne({ libraryId, type: 'collection', collectRequestId: k });
};

const replayCollection = async (libraryId, key, { studentId, amount } = {}) => {
    const prev = await findCollectionByRequestId(libraryId, key);
    if (!prev) return null;
    if (studentId && String(prev.studentId) !== String(studentId)) throw new ApiError(409, 'This request id was already used for a different student');
    if (amount !== undefined && amount !== null && Math.abs(r2(amount) - prev.amount) > EPS && prev.status === 'success') {
        throw new ApiError(409, 'This request id was already used with a different amount');
    }
    if (prev.status !== 'success') {
        throw new ApiError(409, 'This payment request is already being processed, please wait a moment');
    }
    return {
        transaction: prev, receiptNumber: prev.receiptNumber, allocations: prev.allocations, replay: true,
        outstandingAfter: await totalDueOf(libraryId, prev.studentId)
    };
};

// ── createCharge ──────────────────────────────────────────────────────────────
const createCharge = async ({
    libraryId, studentId, planId, amount, dueDate, description, createdBy, couponCode,
    joiningFee = 0, deposit = 0, paidNow = 0, paidAmount, referrerId, periodStart, periodEnd, paymentType, remarks, req,
    skipCreditPolicy = false, extraDiscount = 0, extraDiscountReason
}) => {
    if (!libraryId) throw new ApiError(400, 'libraryId is required');
    if (!isId(studentId)) throw new ApiError(400, 'Valid studentId is required');
    const student = await Student.findOne({ _id: studentId, libraryId });
    if (!student) throw new ApiError(404, 'Student not found in this library');

    let plan = null;
    if (planId) {
        if (!isId(planId)) throw new ApiError(400, 'Invalid planId');
        plan = await Plan.findOne({ _id: planId, libraryId });
        if (!plan) throw new ApiError(404, 'Plan not found in this library');
    }

    let membership = amount;
    if (membership === undefined || membership === null || membership === '') {
        if (!plan) throw new ApiError(400, 'amount or planId is required');
        membership = plan.finalPrice != null ? plan.finalPrice : plan.price;
    }
    membership = Number(membership);
    const jf = Number(joiningFee) || 0;
    const dep = Number(deposit) || 0;
    if (!Number.isFinite(membership) || membership < 0 || jf < 0 || dep < 0) throw new ApiError(400, 'Amounts cannot be negative');
    membership = r2(membership);

    const items = [];
    if (membership > 0) items.push({ label: (plan && plan.name) || description || 'Membership fee', kind: 'membership', amount: membership });
    if (jf > 0) items.push({ label: 'Joining fee', kind: 'joining_fee', amount: r2(jf) });
    if (dep > 0) items.push({ label: 'Security deposit', kind: 'deposit', amount: r2(dep) });
    const totalAmount = r2(membership + jf + dep);
    if (totalAmount <= 0) throw new ApiError(400, 'Charge total must be greater than zero');

    // Coupon: discount is computed here, on the membership part only
    let discountAmount = 0;
    let coupon = null;
    if (couponCode) {
        if (membership <= 0) throw new ApiError(400, 'Coupon needs a membership amount');
        const v = await couponService.validateCoupon({ code: couponCode, amount: membership, planId, studentId, libraryId, referrerId });
        discountAmount = v.discountAmount;
        coupon = v.coupon;
    }

    // Internal credit (e.g. unused period of the previous plan on a plan change), applied on top of the coupon
    const extra = r2(Math.max(0, Number(extraDiscount) || 0));
    if (extra > 0) {
        if (r2(discountAmount + extra) > totalAmount + EPS) throw new ApiError(400, 'Discount cannot exceed the charge total');
        discountAmount = r2(discountAmount + extra);
    }
    const net = r2(totalAmount - discountAmount);
    const due = dueDate ? new Date(dueDate) : new Date(Date.now() + 7 * DAY_MS);
    if (Number.isNaN(due.getTime())) throw new ApiError(400, 'Invalid dueDate');

    const paid = Math.min(net, Math.max(0, Number(paidNow || paidAmount) || 0));
    // Membership flows (assign/renew) enforce the credit policy at activation instead (student.markAsPaid)
    if (!skipCreditPolicy) await enforceCreditPolicy({ libraryId, studentId, newDue: net - paid, paidNow: paid, dueDate: due });

    const start = periodStart ? new Date(periodStart) : new Date();
    let end = periodEnd ? new Date(periodEnd) : null;
    if (!end && plan && plan.durationDays) end = new Date(start.getTime() + plan.durationDays * DAY_MS);

    const chargeId = new mongoose.Types.ObjectId();
    let redeemed = false;
    if (coupon) {
        const used = await couponService.recordCouponUsage(coupon._id, libraryId, studentId, chargeId, discountAmount);
        if (!used) throw new ApiError(400, `Coupon "${coupon.code}" is no longer available (usage limit reached)`);
        redeemed = true;
    }

    try {
        const charge = new Payment({
            _id: chargeId,
            libraryId,
            branchId: student.branchId || null,
            studentId,
            planId: plan ? plan._id : undefined,
            totalAmount,
            discountAmount,
            items,
            description: description || (plan ? `${plan.name} fee` : 'Fee'),
            couponId: coupon ? coupon._id : undefined,
            couponCode: coupon ? coupon.code : undefined,
            paymentStatus: 'credit',
            dueDate: due,
            periodStart: start,
            periodEnd: end || undefined,
            paymentType: paymentType || 'new',
            remarks,
            createdBy,
            adjustments: extra > 0 ? [{ type: 'discount', reason: extraDiscountReason || 'Credit applied', amount: extra, by: createdBy }] : []
        });
        await charge.save();
        auditEvent(req, libraryId, createdBy || studentId, 'payment.charge.create', 'Payment', charge._id, {
            studentId, totalAmount, discountAmount, couponCode: charge.couponCode, dueDate: due
        });
        const unpaid = r2(net - paid);
        if (unpaid > EPS) {
            notifyLater(() => require('./notification.service').notifyEvent('fee-due', libraryId, {
                studentId, variables: { amount: unpaid, dueDate: due.toISOString().slice(0, 10) },
                data: { type: 'fee_due', paymentId: String(charge._id) }, dedupeKey: `charge:${charge._id}`
            }));
        }
        return charge;
    } catch (e) {
        if (redeemed) await couponService.releaseCouponUsage(coupon._id, libraryId, chargeId).catch(() => {});
        throw e;
    }
};

// Optimistic-concurrency retries: many staff/devices can hit one charge at once; wait a random, growing moment before re-reading
const OCC_TRIES = 15;
const occPause = (i) => new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 12 * (i + 1))));

// ── recordPayment (allocation engine) ─────────────────────────────────────────
const applyToCharge = async ({ libraryId, studentId, paymentId, amount, txnId, method, receivedBy, paymentDate, razorpayPaymentId }) => {
    for (let i = 0; i < OCC_TRIES; i += 1) {
        const charge = await Payment.findOne({ _id: paymentId, libraryId, studentId });
        if (!charge) throw new ApiError(404, 'Charge not found for this student');
        if (TERMINAL_STATUSES.includes(charge.paymentStatus) || charge.paymentStatus === 'waived') {
            throw new ApiError(400, `Cannot collect on a ${charge.paymentStatus} charge`);
        }
        if (amount > charge.dueAmount + EPS) {
            throw new ApiError(400, `Amount ₹${amount} exceeds the due ₹${charge.dueAmount} on this charge`);
        }
        const dueBefore = charge.dueAmount;
        charge.paidAmount = r2(charge.paidAmount + amount);
        charge.paymentDate = paymentDate || new Date();
        charge.paymentMethod = method;
        if (receivedBy) charge.collectedBy = receivedBy;
        if (razorpayPaymentId) charge.razorpayPaymentId = razorpayPaymentId;
        charge.allocations.push({
            chargeMonth: monthKey(charge.periodStart || charge.dueDate || charge.createdAt),
            allocatedAmount: amount,
            transactionId: txnId,
            method,
            date: paymentDate || new Date()
        });
        try {
            await charge.save();
            return { charge, dueBefore };
        } catch (e) {
            if (e.name === 'VersionError') { await occPause(i); continue; }
            throw e;
        }
    }
    throw new ApiError(409, 'This charge is being updated by someone else, please retry');
};

const rollbackApplied = async (applied, libraryId, txnId) => {
    for (const a of applied) {
        for (let i = 0; i < OCC_TRIES; i += 1) {
            const charge = await Payment.findOne({ _id: a.paymentId, libraryId });
            if (!charge) break;
            charge.paidAmount = r2(Math.max(0, charge.paidAmount - a.amount));
            charge.allocations = charge.allocations.filter((x) => String(x.transactionId) !== String(txnId));
            try { await charge.save(); break; } catch (e) { if (e.name !== 'VersionError') break; await occPause(i); }
        }
    }
};

const recordPayment = async ({
    libraryId, studentId, amount, method = 'cash', reference, receivedBy, allocations, paymentDate, note, req,
    receivedByType, attempt, source = 'manual', razorpayPaymentId, razorpaySignature, trustedAllocation = false,
    collectRequestId
}) => {
    if (!libraryId) throw new ApiError(400, 'libraryId is required');
    if (!isId(studentId)) throw new ApiError(400, 'Valid studentId is required');
    if (!['cash', 'upi', 'online', 'bank_transfer', 'other'].includes(method)) throw new ApiError(400, 'Invalid payment method');
    const amt = validAmount(amount);
    const reqKey = cleanRequestKey(collectRequestId);
    if (reqKey && !attempt) {
        const replay = await replayCollection(libraryId, reqKey, { studentId, amount: amt });
        if (replay) return replay;
    }
    const when = paymentDate ? new Date(paymentDate) : new Date();
    if (Number.isNaN(when.getTime())) throw new ApiError(400, 'Invalid paymentDate');
    if (when.getTime() > Date.now() + DAY_MS) throw new ApiError(400, 'paymentDate cannot be in the future');

    const student = await Student.findOne({ _id: studentId, libraryId });
    if (!student) throw new ApiError(404, 'Student not found in this library');

    // Explicit allocation is a privileged action
    if (allocations && allocations.length && !trustedAllocation) assertPermission(req, PERM_KEYS.allocate);

    const policy = await getPolicy(libraryId);
    const open = await Payment.find({
        libraryId, studentId, paymentStatus: { $in: OPEN_STATUSES }, dueAmount: { $gt: 0 }
    }).sort({ dueDate: 1, createdAt: 1 });
    const totalDue = r2(open.reduce((s, c) => s + c.dueAmount, 0));
    if (open.length === 0) throw new ApiError(400, 'This student has no outstanding dues');

    // Build the allocation plan
    let plan = [];
    if (allocations && allocations.length) {
        const seen = new Set();
        let sum = 0;
        for (const a of allocations) {
            const pid = String(a.paymentId || a.chargeId || '');
            if (!isId(pid)) throw new ApiError(400, 'Invalid paymentId in allocations');
            if (seen.has(pid)) throw new ApiError(400, 'Duplicate charge in allocations');
            seen.add(pid);
            const charge = open.find((c) => String(c._id) === pid);
            if (!charge) throw new ApiError(400, 'Allocation refers to a charge that is not open for this student');
            const v = validAmount(a.amount, 'allocation amount');
            if (v > charge.dueAmount + EPS) throw new ApiError(400, `Allocation ₹${v} exceeds due ₹${charge.dueAmount}`);
            sum = r2(sum + v);
            plan.push({ paymentId: charge._id, amount: v, description: charge.description, dueBefore: charge.dueAmount });
        }
        if (Math.abs(sum - amt) > EPS) throw new ApiError(400, `Allocations total ₹${sum} does not match amount ₹${amt}`);
    } else {
        if (amt > totalDue + EPS) {
            throw new ApiError(400, `Payment of ₹${amt} exceeds outstanding ₹${totalDue}. Over-payment/advance is not accepted`);
        }
        let remaining = amt;
        for (const c of open) {
            if (remaining <= EPS) break;
            const take = r2(Math.min(remaining, c.dueAmount));
            plan.push({ paymentId: c._id, amount: take, description: c.description, dueBefore: c.dueAmount });
            remaining = r2(remaining - take);
        }
    }

    // Transaction (receipt) record
    let txn;
    if (attempt) {
        txn = attempt;
    } else {
        txn = new PaymentTransaction({
            libraryId, branchId: student.branchId || null, studentId, type: 'collection', status: 'processing', amount: amt, method, reference, note,
            paymentDate: when, receivedBy, receivedByType: receivedByType || (req && req.userType) || 'system', source,
            ...(reqKey ? { collectRequestId: reqKey } : {})
        });
        try {
            await txn.save();
        } catch (e) {
            // A concurrent request with the same idempotency key won the unique index: answer from it
            if (e && e.code === 11000 && reqKey) {
                const replay = await replayCollection(libraryId, reqKey, { studentId, amount: amt });
                if (replay) return replay;
            }
            throw e;
        }
    }

    const applied = [];
    try {
        const snapshot = [];
        for (const p of plan) {
            const { charge, dueBefore } = await applyToCharge({
                libraryId, studentId, paymentId: p.paymentId, amount: p.amount, txnId: txn._id,
                method, receivedBy, paymentDate: when, razorpayPaymentId
            });
            applied.push({ paymentId: p.paymentId, amount: p.amount });
            snapshot.push({
                paymentId: charge._id, amount: p.amount, description: charge.description,
                dueBefore, dueAfter: charge.dueAmount
            });
        }
        const receiptNumber = await nextReceiptNo(libraryId);
        txn.set({
            status: 'success', receiptNumber, allocations: snapshot, amount: amt, method, reference: reference || txn.reference,
            note: note || txn.note, paymentDate: when, processingAt: undefined, failureReason: undefined, source,
            razorpayPaymentId: razorpayPaymentId || txn.razorpayPaymentId,
            razorpaySignature: razorpaySignature || txn.razorpaySignature
        });
        await txn.save();
        // stamp receipt number on charge allocations
        await Payment.updateMany(
            { libraryId, _id: { $in: snapshot.map((s) => s.paymentId) } },
            { $set: { 'allocations.$[a].receiptNumber': receiptNumber } },
            { arrayFilters: [{ 'a.transactionId': txn._id }] }
        );
    } catch (e) {
        await rollbackApplied(applied, libraryId, txn._id);
        if (attempt) {
            await PaymentTransaction.updateOne({ _id: txn._id }, { $set: { status: 'failed', failureReason: e.message } });
        } else {
            await PaymentTransaction.deleteOne({ _id: txn._id });
        }
        throw e;
    }

    // Side effects (never fail the payment). Dues are re-read from the DB, not derived from the pre-write snapshot.
    const remainingDue = await refreshStudentPaymentStatus(libraryId, studentId);
    auditEvent(req, libraryId, studentId, 'payment.collect', 'PaymentTransaction', txn._id, {
        studentId, amount: amt, method, receiptNumber: txn.receiptNumber, allocations: plan.map((p) => ({ paymentId: p.paymentId, amount: p.amount })), source
    });
    notifyLater(async () => {
        const { notifyLibraryAdmins } = require('./firebase.service');
        await require('./notification.service').notifyEvent('payment-received', libraryId, {
            studentId, variables: { amount: amt, receiptNo: txn.receiptNumber },
            data: { type: 'payment_received', transactionId: String(txn._id) }, dedupeKey: `txn:${txn._id}`
        });
        if (source !== 'manual') {
            await notifyLibraryAdmins(libraryId, 'Online Payment Received', `₹${amt} received from ${student.name} (online)`, {}, 'payment_received');
        }
    });

    return { transaction: txn, receiptNumber: txn.receiptNumber, outstandingAfter: remainingDue, allocations: txn.allocations };
};

// ── online payment attempts ───────────────────────────────────────────────────
/** Validate a requested online payment against DB charges and create the pending attempt. */
const createOnlineAttempt = async ({ libraryId, studentId, chargeIds, amount, createdBy, createdByType }) => {
    if (!isId(studentId)) throw new ApiError(400, 'Valid studentId is required');
    const student = await Student.findOne({ _id: studentId, libraryId });
    if (!student) throw new ApiError(404, 'Student not found in this library');

    const q = { libraryId, studentId, paymentStatus: { $in: OPEN_STATUSES }, dueAmount: { $gt: 0 } };
    if (chargeIds && chargeIds.length) {
        chargeIds.forEach((id) => { if (!isId(id)) throw new ApiError(400, 'Invalid charge id'); });
        q._id = { $in: chargeIds };
    }
    const charges = await Payment.find(q).sort({ dueDate: 1, createdAt: 1 });
    if (charges.length === 0) throw new ApiError(400, 'No payable dues found');
    if (chargeIds && chargeIds.length && charges.length !== new Set(chargeIds.map(String)).size) {
        throw new ApiError(400, 'One or more charges are not payable');
    }
    const payable = r2(charges.reduce((s, c) => s + c.dueAmount, 0));
    const amt = amount === undefined || amount === null ? payable : validAmount(amount);
    if (amt > payable + EPS) throw new ApiError(400, `Amount exceeds payable dues of ₹${payable}`);

    let remaining = amt;
    const plan = [];
    for (const c of charges) {
        if (remaining <= EPS) break;
        const take = r2(Math.min(remaining, c.dueAmount));
        plan.push({ paymentId: c._id, amount: take, description: c.description, dueBefore: c.dueAmount });
        remaining = r2(remaining - take);
    }

    const attempt = await PaymentTransaction.create({
        libraryId, branchId: student.branchId || null, studentId, type: 'collection', status: 'pending', amount: amt, method: 'online',
        allocations: plan, receivedBy: createdByType === 'student' ? undefined : createdBy,
        receivedByType: createdByType || 'student', source: 'verify'
    });
    return { attempt, payable, student };
};

const failAttempt = async (attempt, reason, extra = {}) =>
    PaymentTransaction.findOneAndUpdate(
        { _id: attempt._id, status: { $in: ['pending', 'processing'] } },
        { $set: { status: 'failed', failureReason: reason, ...extra } },
        { new: true }
    );

/** Atomically claim a pending attempt for processing (stale claims older than 2 min can be re-taken). */
const claimAttempt = async (filter) => {
    const now = new Date();
    return PaymentTransaction.findOneAndUpdate(
        {
            ...filter,
            type: 'collection',
            $or: [
                { status: 'pending' },
                { status: 'failed', needsReview: { $ne: true } },
                { status: 'processing', processingAt: { $lt: new Date(now.getTime() - 120000) } }
            ]
        },
        { $set: { status: 'processing', processingAt: now } },
        { new: true }
    );
};

/**
 * Finish a claimed (processing) online attempt after a VERIFIED signature/webhook.
 * Allocates via recordPayment; on failure the dues stay unchanged and the attempt is marked failed
 * (needsReview, since money may have been captured).
 */
const finalizeOnlineAttempt = async (attempt, { razorpayPaymentId, razorpaySignature, source = 'verify' }) => {
    const planned = attempt.allocations.map((a) => ({ paymentId: a.paymentId, amount: a.amount }));
    const trusted = { trustedAllocation: true };
    const base = {
        libraryId: attempt.libraryId, studentId: attempt.studentId, amount: attempt.amount, method: 'online',
        reference: razorpayPaymentId, receivedBy: attempt.receivedBy, receivedByType: attempt.receivedByType || 'student',
        attempt, source, razorpayPaymentId, razorpaySignature, paymentDate: new Date(),
        note: 'Online payment (Razorpay)'
    };
    try {
        try {
            return await recordPayment({ ...base, ...trusted, allocations: planned });
        } catch (e) {
            // Dues may have moved since the order was created (e.g. cash collected meanwhile): retry oldest-first
            if (!(e instanceof ApiError) || e.statusCode === 404) throw e;
            return await recordPayment({ ...base });
        }
    } catch (e) {
        await failAttempt(attempt, `Allocation failed: ${e.message}`, {
            needsReview: true, razorpayPaymentId, razorpaySignature
        });
        notifyLater(async () => {
            const { notifyLibraryAdmins } = require('./firebase.service');
            await notifyLibraryAdmins(attempt.libraryId, 'Online payment needs review',
                `Payment ${razorpayPaymentId} of ₹${attempt.amount} was received but could not be allocated. Please reconcile / refund.`,
                { transactionId: String(attempt._id) }, 'payment_alert');
        });
        throw e;
    }
};

// ── cancel / refund / adjust / waive ─────────────────────────────────────────
const loadChargeForWrite = async (libraryId, paymentId) => {
    if (!isId(paymentId)) throw new ApiError(400, 'Invalid payment id');
    const charge = await Payment.findOne({ _id: paymentId, libraryId });
    if (!charge) throw new ApiError(404, 'Payment not found');
    return charge;
};

/** A mutate callback returns this when the change is already on the charge: saveCharge then writes nothing. */
const ALREADY_APPLIED = Symbol('alreadyApplied');

/**
 * Has the request with this idempotency key already changed this charge? The key is stored on the adjustment entry, so
 * it is saved in the same write as the change itself: the change and its key can never be split, and two parallel
 * requests with one key are settled by the charge's version check (the loser reloads and finds the key). A key is only
 * looked up on its own charge. Refused requests store nothing, so they can be retried with the same key.
 */
const alreadyApplied = (charge, key, signature) => {
    if (!key) return false;
    const prev = charge.adjustments.find((a) => a.requestId === key);
    if (!prev) return false;
    if (prev.requestSignature !== signature) throw new ApiError(409, 'This request id was already used for a different change');
    return true;
};

const saveCharge = async (mutate, libraryId, paymentId) => {
    for (let i = 0; i < OCC_TRIES; i += 1) {
        const charge = await loadChargeForWrite(libraryId, paymentId);
        const result = await mutate(charge);
        if (result === ALREADY_APPLIED) {
            charge.$locals.replay = true;
            return { charge, result };
        }
        try {
            await charge.save();
            return { charge, result };
        } catch (e) {
            if (e.name === 'VersionError') { await occPause(i); continue; }
            throw e;
        }
    }
    throw new ApiError(409, 'This charge is being updated by someone else, please retry');
};

/** Silent void of a just-created charge when the follow-up collection failed. */
const rollbackCharge = async (libraryId, chargeId, reason) => {
    try {
        const { charge } = await saveCharge((c) => {
            c.paymentStatus = 'cancelled';
            c.cancelledAt = new Date();
            c.cancelReason = reason;
        }, libraryId, chargeId);
        if (charge.couponId) await couponService.releaseCouponUsage(charge.couponId, libraryId, charge._id).catch(() => {});
    } catch (e) { /* best effort */ }
};

const cancelCharge = async ({ libraryId, paymentId, reason, req, userId, trusted = false, requestId }) => {
    if (!trusted) assertPermission(req, PERM_KEYS.adjust);
    if (!reason || !String(reason).trim()) throw new ApiError(400, 'A reason is required to cancel a charge');
    const reqKey = cleanRequestKey(requestId);
    const { charge, result } = await saveCharge((c) => {
        if (alreadyApplied(c, reqKey, 'cancel')) return ALREADY_APPLIED; // before the status checks: a replay finds it cancelled
        if (c.paymentStatus === 'cancelled') throw new ApiError(400, 'Charge is already cancelled');
        if (c.paymentStatus === 'refunded') throw new ApiError(400, 'A refunded charge cannot be cancelled');
        if (r2(c.paidAmount - c.refundAmount) > EPS) throw new ApiError(400, 'Money was collected on this charge: refund it before cancelling');
        c.paymentStatus = 'cancelled';
        c.cancelledAt = new Date();
        c.cancelReason = String(reason).trim();
        c.cancelledBy = userId || (req && req.user && req.user._id);
        c.adjustments.push({ type: 'cancel', reason: c.cancelReason, amount: c.totalAmount, by: c.cancelledBy, ...(reqKey ? { requestId: reqKey, requestSignature: 'cancel' } : {}) });
        return undefined;
    }, libraryId, paymentId);
    if (result === ALREADY_APPLIED) return charge;
    if (charge.couponId) await couponService.releaseCouponUsage(charge.couponId, libraryId, charge._id).catch(() => {});
    await refreshStudentPaymentStatus(libraryId, charge.studentId);
    auditEvent(req, libraryId, userId, 'payment.cancel', 'Payment', charge._id, { reason: charge.cancelReason, totalAmount: charge.totalAmount });
    notifyLater(() => require('./notification.service').notifyEvent('payment-adjusted', libraryId, {
        studentId: charge.studentId, variables: { amount: charge.totalAmount, action: 'cancelled', receiptSuffix: '' },
        data: { type: 'payment_cancelled', paymentId: String(charge._id) }, dedupeKey: `cancel:${charge._id}`
    }));
    return charge;
};

const MANUAL_GATEWAY_PERM = ['fees.adjust', 'FEES_ADJUST', 'ADJUST_PAYMENT'];
const toPaise = (inr) => Math.round(r2(inr) * 100);

/** Find a refund we already created at the gateway for this request id (used after an ambiguous failure). */
const findGatewayRefundByRequestId = async (rz, gatewayPaymentId, requestId) => {
    if (!requestId || !rz.payments || typeof rz.payments.fetchMultipleRefund !== 'function') return null;
    const list = await rz.payments.fetchMultipleRefund(gatewayPaymentId, { count: 100 });
    const items = (list && (list.items || list)) || [];
    return (Array.isArray(items) ? items : []).find((r) => r && r.notes && r.notes.refundRequestId === requestId) || null;
};

/**
 * Refund (bookkeeping + Razorpay for online payments).
 *  - requestId: idempotency key. Replays of a successful request return the stored refund; an in-flight one is a 409.
 *  - refundToGateway (default true): for online Razorpay receipts the refund is issued through the Razorpay API.
 *    false = the library refunded manually outside the gateway; needs fees.adjust and a reason mentioning "manual".
 *  - razorpayRefundId: internal (webhook / recovery) - refund already exists at the gateway, never call it again.
 * Order: validate -> create pending record -> gateway call -> ledger mutation -> finalize + audit + R- receipt.
 */
const refundPayment = async ({
    libraryId, paymentId, transactionId, amount, reason, method, req, userId, razorpayRefundId, razorpayPaymentId,
    requestId, refundToGateway = true
}) => {
    assertPermission(req, PERM_KEYS.refund);
    if (!reason || !String(reason).trim()) throw new ApiError(400, 'A reason is required for a refund');
    const cleanReason = String(reason).trim();
    const reqId = requestId ? String(requestId).trim().slice(0, 100) : null;

    // Idempotent replay / retry of a previous request
    let retryDoc = null;
    if (reqId) {
        const prev = await PaymentTransaction.findOne({ libraryId, type: 'refund', refundRequestId: reqId });
        if (prev) {
            if (amount !== undefined && amount !== null && Math.abs(r2(amount) - prev.amount) > EPS) {
                throw new ApiError(409, 'This request id was already used with a different amount');
            }
            if (prev.status === 'success') { prev.$locals.replay = true; return prev; }
            if (prev.status === 'pending' || prev.status === 'processing') {
                if (Date.now() - new Date(prev.processingAt || prev.createdAt).getTime() < 120000) {
                    throw new ApiError(409, 'This refund request is already being processed');
                }
            }
            retryDoc = prev;
        }
    }

    // Build the list of {chargeId, transactionId, available} slices that can be refunded (newest first)
    let slices = [];
    let sourceTxn = null;
    let studentId;
    let refundBranchId = null;
    if (transactionId) {
        if (!isId(transactionId)) throw new ApiError(400, 'Invalid transaction id');
        sourceTxn = await PaymentTransaction.findOne({ _id: transactionId, libraryId, type: 'collection', status: 'success' });
        if (!sourceTxn) throw new ApiError(404, 'Receipt not found');
        studentId = sourceTxn.studentId;
        refundBranchId = sourceTxn.branchId || null;
        slices = sourceTxn.allocations
            .filter((a) => !paymentId || String(a.paymentId) === String(paymentId)) // only the charge named in the route
            .map((a) => ({ chargeId: a.paymentId, txnId: sourceTxn._id, available: r2(a.amount - (a.refunded || 0)) })).reverse();
    } else {
        const charge = await loadChargeForWrite(libraryId, paymentId);
        studentId = charge.studentId;
        refundBranchId = charge.branchId || null;
        if (charge.paymentStatus === 'cancelled') throw new ApiError(400, 'Cannot refund a cancelled charge');
        const refundable = r2(charge.paidAmount - charge.refundAmount);
        if (refundable <= EPS) throw new ApiError(400, 'Nothing left to refund on this charge');
        let acc = 0;
        slices = charge.allocations
            .filter((a) => a.transactionId)
            .map((a) => ({ chargeId: charge._id, txnId: a.transactionId, available: r2(a.allocatedAmount - (a.refundedAmount || 0)) }))
            .reverse();
        acc = slices.reduce((s, x) => s + x.available, 0);
        if (acc + EPS < refundable) slices.push({ chargeId: charge._id, txnId: null, available: r2(refundable - acc) });
    }
    slices = slices.filter((s) => s.available > EPS);
    const totalAvailable = r2(slices.reduce((s, x) => s + x.available, 0));
    if (totalAvailable <= EPS) throw new ApiError(400, 'Nothing left to refund');
    const refundAmt = amount === undefined || amount === null ? totalAvailable : validAmount(amount, 'refund amount');
    if (refundAmt > totalAvailable + EPS) throw new ApiError(400, `Refund ₹${refundAmt} exceeds refundable ₹${totalAvailable}`);

    // Distribute
    let remaining = refundAmt;
    const dist = [];
    for (const s of slices) {
        if (remaining <= EPS) break;
        const take = r2(Math.min(remaining, s.available));
        dist.push({ ...s, take });
        remaining = r2(remaining - take);
    }

    // ── online (Razorpay) payments: decide whether the money goes back through the gateway ──
    let gatewayTxn = null; // the captured online receipt to refund against
    let manualOnline = false;
    if (!razorpayRefundId) {
        const srcIds = [...new Set(dist.filter((d) => d.txnId).map((d) => String(d.txnId)))];
        const sources = srcIds.length
            ? await PaymentTransaction.find({ _id: { $in: srcIds }, libraryId, type: 'collection', status: 'success' })
            : [];
        const online = sources.filter((t) => t.method === 'online' && t.razorpayPaymentId);
        if (online.length) {
            if (refundToGateway === false) {
                assertPermission(req, MANUAL_GATEWAY_PERM);
                if (!/manual/i.test(cleanReason)) {
                    throw new ApiError(400, 'Refunding an online payment outside the gateway requires a reason that notes the manual refund');
                }
                manualOnline = true;
            } else {
                const allOnlineOne = online.length === 1 && dist.every((d) => d.txnId && String(d.txnId) === String(online[0]._id));
                if (!allOnlineOne) {
                    throw new ApiError(400, 'This refund spans several receipts or mixes online and offline payments. Refund each online receipt separately by passing its transactionId');
                }
                gatewayTxn = online[0];
                const capturedPaise = toPaise(gatewayTxn.amount);
                const alreadyPaise = toPaise(gatewayTxn.allocations.reduce((s, a) => s + (a.refunded || 0), 0));
                if (toPaise(refundAmt) > capturedPaise - alreadyPaise) {
                    throw new ApiError(400, 'Refund exceeds the amount captured for this online payment');
                }
            }
        }
    }
    const gatewayPaymentId = gatewayTxn ? gatewayTxn.razorpayPaymentId : razorpayPaymentId;
    const creating = {
        libraryId, branchId: refundBranchId, studentId, type: 'refund', status: gatewayTxn ? 'pending' : 'processing', amount: refundAmt,
        method: (gatewayTxn || razorpayRefundId) ? 'online' : (method || 'cash'),
        reason: cleanReason, refundOf: sourceTxn ? sourceTxn._id : (gatewayTxn ? gatewayTxn._id : undefined),
        razorpayRefundId, razorpayPaymentId: gatewayPaymentId, refundRequestId: reqId || undefined,
        refundToGateway: gatewayTxn ? true : (manualOnline ? false : undefined),
        receivedBy: userId || (req && req.user && req.user._id), receivedByType: (req && req.userType) || 'system',
        source: req ? 'manual' : 'webhook', processingAt: gatewayTxn ? undefined : new Date()
    };
    let refundTxn;
    if (retryDoc) {
        // re-take a failed / abandoned attempt of the same request
        refundTxn = await PaymentTransaction.findOneAndUpdate(
            { _id: retryDoc._id, libraryId, status: { $in: ['failed', 'pending', 'processing'] } },
            { $set: { status: gatewayTxn ? 'pending' : 'processing', failureReason: undefined, processingAt: gatewayTxn ? undefined : new Date(), amount: refundAmt, reason: cleanReason,
                ...(razorpayRefundId ? { razorpayRefundId } : {}) } },
            { new: true }
        );
        if (!refundTxn) throw new ApiError(409, 'This refund request is already being processed');
        if (retryDoc.status !== 'failed') refundTxn.gatewayUnknown = true; // abandoned mid-flight: verify at the gateway first
    } else {
        try {
            refundTxn = await PaymentTransaction.create(creating);
        } catch (e) {
            if (e && e.code === 11000) throw new ApiError(409, 'This refund request is already being processed');
            throw e;
        }
    }

    // ── gateway call (between local validation and the ledger mutation) ──
    let gatewayRefundId = refundTxn.razorpayRefundId || razorpayRefundId || null;
    if (gatewayTxn && !gatewayRefundId) {
        const claimed = await PaymentTransaction.findOneAndUpdate(
            { _id: refundTxn._id, status: 'pending' },
            { $set: { status: 'processing', processingAt: new Date() } },
            { new: true }
        );
        if (!claimed) throw new ApiError(409, 'This refund request is already being processed');
        const verifyFirst = !!refundTxn.gatewayUnknown;
        refundTxn = claimed;
        let rf = null;
        try {
            const rz = require('./razorpayClient').getClient();
            if (verifyFirst) rf = await findGatewayRefundByRequestId(rz, gatewayTxn.razorpayPaymentId, reqId);
            if (!rf) {
                rf = await rz.payments.refund(gatewayTxn.razorpayPaymentId, {
                    amount: toPaise(refundAmt),
                    speed: 'normal',
                    receipt: `rf_${refundTxn._id}`,
                    notes: {
                        refundRequestId: reqId || String(refundTxn._id),
                        refundTxnId: String(refundTxn._id),
                        libraryId: String(libraryId),
                        reason: cleanReason.slice(0, 200)
                    }
                });
            }
            if (!rf || !rf.id) throw new Error('Gateway returned no refund id');
        } catch (e) {
            const code = Number(e && e.statusCode);
            const definite = e instanceof ApiError ? e.statusCode < 500 : (code >= 400 && code < 500);
            const detail = (e && e.error && e.error.description) || (e && e.message) || 'gateway error';
            console.error('[feeLedger] Razorpay refund failed:', detail);
            await PaymentTransaction.updateOne({ _id: refundTxn._id }, { $set: {
                status: 'failed', failureReason: `Gateway refund failed: ${String(detail).slice(0, 200)}`,
                gatewayUnknown: !definite, needsReview: !definite
            } });
            throw new ApiError(502, definite
                ? 'The payment gateway rejected the refund. No changes were made'
                : 'The payment gateway did not confirm the refund. No changes were made; retry with the same request id');
        }
        gatewayRefundId = rf.id;
        await PaymentTransaction.updateOne({ _id: refundTxn._id }, { $set: { razorpayRefundId: rf.id, gatewayUnknown: false, needsReview: false } });
        refundTxn.razorpayRefundId = rf.id;
    }

    const done = [];
    try {
        const perCharge = new Map();
        dist.forEach((d) => perCharge.set(String(d.chargeId), (perCharge.get(String(d.chargeId)) || 0) + d.take));
        for (const [cid, amtForCharge] of perCharge) {
            await saveCharge((c) => {
                if (c.paymentStatus === 'cancelled') throw new ApiError(400, 'Charge was cancelled');
                if (amtForCharge > r2(c.paidAmount - c.refundAmount) + EPS) throw new ApiError(400, 'Refund exceeds amount paid on charge');
                c.refundAmount = r2(c.refundAmount + amtForCharge);
                c.refundReason = cleanReason;
                c.refundDate = new Date();
                let left = amtForCharge;
                dist.filter((d) => String(d.chargeId) === cid && d.txnId).forEach((d) => {
                    const al = c.allocations.find((a) => String(a.transactionId) === String(d.txnId));
                    if (al) al.refundedAmount = r2((al.refundedAmount || 0) + d.take);
                    left = r2(left - d.take);
                });
                c.adjustments.push({ type: 'refund', reason: cleanReason, amount: amtForCharge, by: userId || (req && req.user && req.user._id) });
            }, libraryId, cid);
            done.push({ cid, amt: amtForCharge });
        }
        // mirror on source receipts
        for (const d of dist.filter((x) => x.txnId)) {
            await PaymentTransaction.updateOne(
                { _id: d.txnId, libraryId },
                { $inc: { 'allocations.$[a].refunded': d.take } },
                { arrayFilters: [{ 'a.paymentId': d.chargeId }] }
            );
        }
        const refundNo = await nextReceiptNo(libraryId, 'refund');
        refundTxn.set({
            status: 'success', receiptNumber: refundNo, processingAt: undefined, failureReason: undefined, needsReview: false,
            allocations: dist.map((d) => ({ paymentId: d.chargeId, amount: d.take }))
        });
        await refundTxn.save();
    } catch (e) {
        // best-effort compensation
        for (const d of done) {
            await saveCharge((c) => {
                c.refundAmount = r2(Math.max(0, c.refundAmount - d.amt));
                if (c.paymentStatus === 'refunded') c.paymentStatus = 'paid';
            }, libraryId, d.cid).catch(() => {});
        }
        const issued = !!gatewayRefundId && !!gatewayTxn;
        await PaymentTransaction.updateOne({ _id: refundTxn._id }, { $set: {
            status: 'failed', failureReason: e.message, needsReview: issued || undefined
        } });
        if (issued) {
            console.error('[feeLedger] gateway refund issued but ledger update failed:', gatewayRefundId, e.message);
            notifyLater(async () => {
                const { notifyLibraryAdmins } = require('./firebase.service');
                await notifyLibraryAdmins(libraryId, 'Refund needs review',
                    `Refund ${gatewayRefundId} was issued at the gateway but could not be recorded. It will be applied when the gateway confirms it, or retry with the same request id.`,
                    { transactionId: String(refundTxn._id) }, 'payment_alert');
            });
            throw new ApiError(500, 'The refund was issued at the gateway but could not be recorded yet. It has been flagged for review; retry with the same request id');
        }
        throw e;
    }

    auditEvent(req, libraryId, studentId, 'payment.refund', 'PaymentTransaction', refundTxn._id, {
        studentId, amount: refundAmt, reason: cleanReason, paymentId, transactionId, receiptNumber: refundTxn.receiptNumber,
        requestId: reqId || undefined, razorpayRefundId: gatewayRefundId || undefined,
        gateway: gatewayTxn ? true : undefined, manualGatewayRefund: manualOnline || undefined
    });
    notifyLater(async () => {
        await require('./notification.service').notifyEvent('payment-adjusted', libraryId, {
            studentId, variables: { amount: refundAmt, action: 'refunded', receiptSuffix: ` Ref: ${refundTxn.receiptNumber}` },
            data: { type: 'payment_refund', transactionId: String(refundTxn._id) }, dedupeKey: `refund:${refundTxn._id}`
        });
    });
    return refundTxn;
};

/** What an adjust request asks for: one key may only be replayed with the same change. */
const adjustSignature = ({ waiveAmount, lateFee, discountAmount, totalAmount, dueDate }) => {
    const money = (v) => (v === undefined || v === null ? null : r2(v));
    return JSON.stringify({ waiveAmount: money(waiveAmount), lateFee: money(lateFee), discountAmount: money(discountAmount), totalAmount: money(totalAmount), dueDate: dueDate ? new Date(dueDate).getTime() : null });
};

const adjustCharge = async ({ libraryId, paymentId, reason, waiveAmount, lateFee, discountAmount, totalAmount, dueDate, req, userId, trusted = false, requestId }) => {
    if (!trusted) assertPermission(req, PERM_KEYS.adjust);
    if (!reason || !String(reason).trim()) throw new ApiError(400, 'A reason is required for an adjustment');
    const cleanReason = String(reason).trim();
    const by = userId || (req && req.user && req.user._id);
    const changes = {};
    const reqKey = cleanRequestKey(requestId);
    const signature = adjustSignature({ waiveAmount, lateFee, discountAmount, totalAmount, dueDate });

    const { charge, result } = await saveCharge((c) => {
        if (alreadyApplied(c, reqKey, signature)) return ALREADY_APPLIED; // before the status checks: the charge may have moved on since
        if (TERMINAL_STATUSES.includes(c.paymentStatus)) throw new ApiError(400, `Cannot adjust a ${c.paymentStatus} charge`);
        if (totalAmount !== undefined && totalAmount !== null) {
            const v = Number(totalAmount);
            if (!Number.isFinite(v) || v <= 0) throw new ApiError(400, 'totalAmount must be positive');
            changes.totalAmount = [c.totalAmount, r2(v)];
            c.totalAmount = r2(v);
        }
        if (lateFee !== undefined && lateFee !== null) {
            const v = Number(lateFee);
            if (!Number.isFinite(v) || v < 0) throw new ApiError(400, 'lateFee must be zero or positive');
            changes.lateFee = [c.lateFee, r2(v)];
            c.lateFee = r2(v);
        }
        if (discountAmount !== undefined && discountAmount !== null) {
            const v = Number(discountAmount);
            if (!Number.isFinite(v) || v < 0) throw new ApiError(400, 'discountAmount must be zero or positive');
            changes.discountAmount = [c.discountAmount, r2(v)];
            c.discountAmount = r2(v);
        }
        if (dueDate) {
            const d = new Date(dueDate);
            if (Number.isNaN(d.getTime())) throw new ApiError(400, 'Invalid dueDate');
            changes.dueDate = [c.dueDate, d];
            c.dueDate = d;
            if (c.paymentStatus === 'overdue') c.paymentStatus = c.paidAmount > 0 ? 'partial' : 'credit'; // re-evaluated by cron
        }
        const gross = r2(c.totalAmount + c.lateFee - c.discountAmount - c.waivedAmount);
        if (waiveAmount !== undefined && waiveAmount !== null) {
            const w = validAmount(waiveAmount, 'waiveAmount');
            const dueNow = Math.max(0, r2(gross - c.paidAmount));
            if (w > dueNow + EPS) throw new ApiError(400, `Cannot waive ₹${w}; only ₹${dueNow} is due`);
            changes.waived = w;
            c.waivedAmount = r2(c.waivedAmount + w);
        }
        if (r2(c.totalAmount + c.lateFee - c.discountAmount - c.waivedAmount) < r2(c.paidAmount) - EPS) {
            throw new ApiError(400, 'Adjustment would reduce the charge below the amount already paid. Refund first');
        }
        if (Object.keys(changes).length === 0) throw new ApiError(400, 'Nothing to adjust');
        c.adjustments.push({ type: changes.waived ? 'waive' : 'adjust', reason: cleanReason, amount: changes.waived || 0, by, ...(reqKey ? { requestId: reqKey, requestSignature: signature } : {}) });
        return undefined;
    }, libraryId, paymentId);
    if (result === ALREADY_APPLIED) return charge;

    await refreshStudentPaymentStatus(libraryId, charge.studentId);
    auditEvent(req, libraryId, by, changes.waived ? 'payment.waive' : 'payment.adjust', 'Payment', charge._id, { reason: cleanReason, changes });
    return charge;
};

const waiveCharge = async ({ libraryId, paymentId, amount, reason, req, userId }) => {
    let waive = amount;
    if (waive === undefined || waive === null) {
        const c = await loadChargeForWrite(libraryId, paymentId);
        waive = c.dueAmount;
        if (!(waive > 0)) throw new ApiError(400, 'Nothing is due on this charge');
    }
    const result = await adjustCharge({ libraryId, paymentId, waiveAmount: waive, reason, req, userId });
    notifyLater(async () => {
        const charge = result && (result.charge || result);
        if (!charge || !charge.studentId) return;
        await require('./notification.service').notifyEvent('payment-adjusted', libraryId, {
            studentId: charge.studentId, variables: { amount: waive, action: 'waived', receiptSuffix: '' },
            data: { type: 'payment_waived', paymentId: String(paymentId) }
        });
    });
    return result;
};

// ── plan change: credit for the unused part of the current membership ─────────
/** Net amount the student owes on the membership part of a charge (membership items - discount - waiver). */
const membershipNetOf = (c) => {
    const items = c.items || [];
    const membership = items.filter((i) => i.kind === 'membership').reduce((s, i) => s + i.amount, 0);
    const base = items.length ? membership : c.totalAmount;
    return Math.max(0, r2(base - (c.discountAmount || 0) - (c.waivedAmount || 0)));
};

/** The live membership charge of the student's current plan that covers asOf (or null). */
const findMembershipCharge = async (libraryId, studentId, planId, asOf = new Date()) => {
    if (!planId) return null;
    return Payment.findOne({
        libraryId, studentId, planId,
        paymentStatus: { $nin: TERMINAL_STATUSES },
        periodStart: { $lte: asOf }, periodEnd: { $gte: asOf },
        $or: [{ 'items.kind': 'membership' }, { items: { $size: 0 } }]
    }).sort({ createdAt: -1 });
};

/**
 * Plan-change split of the credit (value of the unused period): first it reduces what the student still owes on
 * the old charge (cancel it when nothing at all was used and nothing paid, else waive); any remainder is returned
 * as a discount for the new charge. Pure arithmetic - does not touch the DB.
 */
const splitPlanChangeCredit = ({ credit, dueAmount, paidAmount, membershipNet }) => {
    const c = r2(credit);
    if (c <= EPS) return { cancelOld: false, waiveOld: 0, discountNew: 0 };
    const waiveOld = r2(Math.min(c, Math.max(0, dueAmount)));
    const cancelOld = (paidAmount || 0) <= EPS && c >= membershipNet - EPS && waiveOld >= dueAmount - EPS;
    return { cancelOld, waiveOld: cancelOld ? 0 : waiveOld, discountNew: r2(c - waiveOld) };
};

/** Apply the old-charge side of a plan change (cancel or waive) as a trusted internal action. */
const applyPlanChangeToOldCharge = async ({ libraryId, charge, split, reason, req, userId }) => {
    if (split.cancelOld) {
        await cancelCharge({ libraryId, paymentId: charge._id, reason, req, userId, trusted: true });
    } else if (split.waiveOld > EPS) {
        await adjustCharge({ libraryId, paymentId: charge._id, waiveAmount: split.waiveOld, reason, req, userId, trusted: true });
    }
};

/**
 * After cancelling / fully refunding a charge: say so when it was the membership fee of the student's live plan.
 * The membership itself is deliberately NOT changed automatically (seat, attendance and history depend on it).
 */
const membershipWarning = async (libraryId, charge) => {
    if (!charge || !TERMINAL_STATUSES.includes(charge.paymentStatus)) return null;
    const idOf = (v) => (v && v._id ? v._id : v); // may be populated
    const chargeStudentId = idOf(charge.studentId);
    const chargePlanId = idOf(charge.planId);
    const student = await Student.findOne({ _id: chargeStudentId, libraryId }).select('planId planStatus expiryDate').lean();
    if (!student || !student.planId || !chargePlanId || String(student.planId) !== String(chargePlanId)) return null;
    if (!['active', 'paused'].includes(student.planStatus)) return null;
    if (!(charge.items || []).some((i) => i.kind === 'membership')) return null;
    if (charge.periodEnd && new Date(charge.periodEnd).getTime() < Date.now()) return null;
    const other = await Payment.findOne({
        libraryId, studentId: chargeStudentId, planId: chargePlanId, _id: { $ne: charge._id },
        paymentStatus: { $nin: TERMINAL_STATUSES }, periodEnd: { $gte: new Date() }, 'items.kind': 'membership'
    }).select('_id').lean();
    if (other) return null;
    return "This was the membership fee of the student's current plan. The membership is still active and no fee now covers it - review the membership (pause, extend or change plan) if the student should not keep access.";
};

// ── queries ───────────────────────────────────────────────────────────────────
const buildPaymentFilter = async (libraryId, q = {}, scope = {}) => {
    const Escape = require('../utils/escapeRegex');
    const filter = { libraryId: oid(libraryId), ...scope };
    const and = [];
    if (q.planId) {
        if (!isId(q.planId)) throw new ApiError(400, 'Invalid planId');
        filter.planId = oid(q.planId);
    }
    if (q.overdue === true || q.overdue === 'true') {
        const policy = await getPolicy(libraryId);
        filter.paymentStatus = { $in: OPEN_STATUSES };
        filter.dueAmount = { $gt: 0 };
        filter.dueDate = { $lt: startOfDayIST(new Date(Date.now() - (policy.graceDays || 0) * DAY_MS)) };
    }
    if (q.status && !filter.paymentStatus) {
        const list = String(q.status).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (list.length) filter.paymentStatus = list.length > 1 ? { $in: list } : list[0];
    }
    if (q.method) and.push({ $or: [{ paymentMethod: String(q.method) }, { 'allocations.method': String(q.method) }] });
    if (q.studentId) {
        if (!isId(q.studentId)) throw new ApiError(400, 'Invalid studentId');
        filter.studentId = oid(q.studentId);
    }
    if (q.from || q.to) {
        // Effective date = date of the (last) payment; charges nothing was paid on yet fall back to the billing date
        const range = {};
        if (q.from) {
            const d = new Date(q.from);
            if (Number.isNaN(d.getTime())) throw new ApiError(400, 'Invalid from date');
            range.$gte = startOfDayIST(d);
        }
        if (q.to) {
            const d = new Date(q.to);
            if (Number.isNaN(d.getTime())) throw new ApiError(400, 'Invalid to date');
            range.$lte = endOfDayIST(d);
        }
        and.push({ $or: [{ paymentDate: range }, { paymentDate: null, createdAt: range }] });
    }
    if (q.search && String(q.search).trim()) {
        const rx = new RegExp(Escape(String(q.search).trim()), 'i');
        const students = await Student.find({ libraryId, $or: [{ name: rx }, { mobile: rx }, { rollNumber: rx }] }).select('_id').limit(500).lean();
        const rcpt = await PaymentTransaction.find({ libraryId, receiptNumber: rx }).select('allocations.paymentId').limit(200).lean();
        const fromReceipts = rcpt.flatMap((t) => t.allocations.map((a) => a.paymentId));
        and.push({ $or: [{ studentId: { $in: students.map((s) => s._id) } }, { description: rx }, { _id: { $in: fromReceipts } }] });
    }
    if (and.length) filter.$and = and;
    return filter;
};

const PAYMENT_SORTS = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    amount: { totalAmount: -1, createdAt: -1 },
    due: { dueAmount: -1, createdAt: -1 },
    dueDate: { dueDate: 1, createdAt: -1 },
    paidDate: { paymentDate: -1, createdAt: -1 }
};

const queryPayments = async (libraryId, q = {}, scope = {}) => {
    const filter = await buildPaymentFilter(libraryId, q, scope);
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
    const sort = PAYMENT_SORTS[q.sort] || PAYMENT_SORTS.newest;
    const graceDays = (await getPolicy(libraryId)).graceDays;

    const [payments, total, stats] = await Promise.all([
        Payment.find(filter)
            .populate('studentId', 'name mobile email rollNumber')
            .populate('planId', 'name durationType')
            .populate('collectedBy', 'name')
            .sort(sort).skip((page - 1) * limit).limit(limit).lean(),
        Payment.countDocuments(filter),
        Payment.aggregate([
            { $match: filter },
            { $group: {
                _id: null,
                totalBilled: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'cancelled'] }, 0, { $subtract: [{ $add: ['$totalAmount', '$lateFee'] }, { $add: ['$discountAmount', '$waivedAmount'] }] }] } },
                totalCollected: { $sum: { $subtract: ['$paidAmount', '$refundAmount'] } },
                totalDue: { $sum: '$dueAmount' },
                totalRefunded: { $sum: '$refundAmount' },
                totalWaived: { $sum: '$waivedAmount' },
                count: { $sum: 1 }
            } }
        ]),
    ]);
    const byStatus = await Payment.aggregate([{ $match: filter }, { $group: { _id: '$paymentStatus', count: { $sum: 1 }, due: { $sum: '$dueAmount' } } }]);
    const s = stats[0] || {};
    const now = new Date();
    payments.forEach((p) => { p.isOverdue = isChargeOverdue(p, graceDays, now); });
    return {
        data: payments,
        page, limit, total, totalPages: Math.ceil(total / limit),
        stats: {
            totalBilled: r2(s.totalBilled), totalCollected: r2(s.totalCollected), totalDue: r2(s.totalDue),
            totalRefunded: r2(s.totalRefunded), totalWaived: r2(s.totalWaived), count: s.count || 0,
            byStatus: byStatus.reduce((o, x) => ({ ...o, [x._id]: { count: x.count, due: r2(x.due) } }), {})
        }
    };
};

const getPaymentById = async (libraryId, id, studentId) => {
    if (!isId(id)) throw new ApiError(400, 'Invalid payment id');
    const q = { _id: id, libraryId };
    if (studentId) q.studentId = studentId;
    const p = await Payment.findOne(q)
        .populate('studentId', 'name mobile email rollNumber')
        .populate('planId', 'name durationType price finalPrice')
        .populate('collectedBy', 'name')
        .lean();
    if (!p) throw new ApiError(404, 'Payment not found');
    const policy = await getPolicy(libraryId);
    p.isOverdue = isChargeOverdue(p, policy.graceDays);
    return p;
};

const getStudentLedger = async (libraryId, studentId, { limit = 100 } = {}) => {
    if (!isId(studentId)) throw new ApiError(400, 'Invalid studentId');
    const student = await Student.findOne({ _id: studentId, libraryId }).select('name mobile email rollNumber planId expiryDate planStatus').lean();
    if (!student) throw new ApiError(404, 'Student not found');
    const [outstanding, charges, transactions] = await Promise.all([
        getOutstanding(libraryId, studentId),
        Payment.find({ libraryId, studentId }).populate('planId', 'name').sort({ createdAt: -1 }).limit(limit).lean(),
        PaymentTransaction.find({ libraryId, studentId, status: 'success' }).sort({ createdAt: -1 }).limit(limit).lean()
    ]);
    // Totals cover every charge, not just the (limited) rows returned above
    const [agg] = await Payment.aggregate([
        { $match: { libraryId: oid(libraryId), studentId: oid(studentId), paymentStatus: { $ne: 'cancelled' } } },
        { $group: {
            _id: null,
            billed: { $sum: { $subtract: [{ $add: ['$totalAmount', '$lateFee'] }, { $add: ['$discountAmount', '$waivedAmount'] }] } },
            paid: { $sum: { $subtract: ['$paidAmount', '$refundAmount'] } }
        } }
    ]);
    const totals = agg || { billed: 0, paid: 0 };
    return {
        student, outstanding, charges, transactions,
        summary: { totalBilled: r2(totals.billed), totalPaid: r2(totals.paid), totalOutstanding: outstanding.totalOutstanding }
    };
};

// ── receipts ──────────────────────────────────────────────────────────────────
const normState = (v) => String(v || '').trim().toLowerCase();

/**
 * GST breakdown of a collection receipt (null when the library has not enabled GST, or for refunds).
 * Amounts are treated as GST-inclusive. Refundable security deposits are not taxable, so each allocation is
 * reduced by the deposit share of its charge before the tax is extracted.
 * Place of supply: student's state when known, else the library's. Same state as the library -> CGST+SGST, else IGST.
 */
const buildReceiptTax = ({ library, student, items, charges, txn }) => {
    const cfg = library && library.feeTax;
    if (!cfg || !cfg.gstEnabled || txn.type !== 'collection') return null;
    let gross = 0;
    items.forEach((i) => {
        const c = charges.get(String(i.chargeId)) || {};
        const total = Number(c.totalAmount) || 0;
        const deposit = (c.items || []).filter((x) => x.kind === 'deposit').reduce((sum, x) => sum + x.amount, 0);
        const share = total > 0 ? Math.max(0, (total - deposit) / total) : 1;
        gross += (Number(i.allocated) || 0) * share;
    });
    gross = r2(gross);
    const libState = normState(library.state);
    const supplyState = (student && student.state) || library.state || '';
    const intraState = !libState || !normState(supplyState) || normState(supplyState) === libState;
    const rate = cfg.gstRate != null ? cfg.gstRate : 18;
    const split = computeGst({ gross, rate, intraState });
    return {
        enabled: true, gstin: library.gstNumber || undefined, sacCode: cfg.sacCode || undefined, rate,
        inclusive: true, intraState, placeOfSupply: supplyState || undefined,
        taxableAmount: gross, ...split
    };
};

const buildReceipt = async ({ libraryId, id, studentId }) => {
    if (!isId(id)) throw new ApiError(400, 'Invalid id');
    let txn = await PaymentTransaction.findOne({ _id: id, libraryId, status: 'success', ...(studentId ? { studentId } : {}) })
        .populate('receivedBy', 'name').lean();
    if (!txn) {
        const charge = await Payment.findOne({ _id: id, libraryId, ...(studentId ? { studentId } : {}) }).select('_id').lean();
        if (charge) {
            txn = await PaymentTransaction.findOne({
                libraryId, status: 'success', type: 'collection', 'allocations.paymentId': charge._id
            }).sort({ createdAt: -1 }).populate('receivedBy', 'name').lean();
        }
    }
    if (!txn) throw new ApiError(404, 'Receipt not found');

    const [library, student, charges, outstanding] = await Promise.all([
        Library.findById(libraryId).select('name address city state pincode mobile email gstNumber logo feeTax receipt').lean(),
        Student.findOne({ _id: txn.studentId, libraryId }).select('name mobile email rollNumber state').lean(),
        Payment.find({ _id: { $in: txn.allocations.map((a) => a.paymentId) }, libraryId }).populate('planId', 'name').lean(),
        getOutstanding(libraryId, txn.studentId)
    ]);
    const byId = new Map(charges.map((c) => [String(c._id), c]));
    const items = txn.allocations.map((a) => {
        const c = byId.get(String(a.paymentId)) || {};
        return {
            chargeId: a.paymentId,
            description: a.description || c.description || (c.planId && c.planId.name) || 'Fee',
            plan: c.planId ? c.planId.name : undefined,
            chargeTotal: c.totalAmount,
            discount: c.discountAmount || 0,
            lateFee: c.lateFee || 0,
            allocated: a.amount,
            refunded: a.refunded || 0,
            dueBefore: a.dueBefore,
            dueAfter: a.dueAfter,
            period: c.periodStart ? { start: c.periodStart, end: c.periodEnd } : undefined
        };
    });
    const tax = buildReceiptTax({ library, student, items, charges: byId, txn });
    return {
        receiptNo: txn.receiptNumber,
        type: txn.type,
        date: txn.paymentDate || txn.createdAt,
        library: library && {
            name: library.name, logo: library.logo, mobile: library.mobile, email: library.email, gstNumber: library.gstNumber,
            address: [library.address, library.city, library.state, library.pincode].filter(Boolean).join(', ')
        },
        student,
        items,
        allocations: txn.allocations.map((a) => ({ paymentId: a.paymentId, amount: a.amount, refunded: a.refunded || 0 })),
        method: txn.method,
        reference: txn.reference,
        note: txn.note,
        receivedBy: txn.receivedBy ? txn.receivedBy.name : (txn.receivedByType === 'student' ? 'Online' : undefined),
        tax,
        footerNote: (library && library.receipt && library.receipt.footerNote) || undefined,
        totals: {
            discount: r2(items.reduce((sum, i) => sum + (i.discount || 0), 0)),
            lateFee: r2(items.reduce((sum, i) => sum + (i.lateFee || 0), 0)),
            amountReceived: txn.amount,
            refunded: r2(txn.allocations.reduce((s, a) => s + (a.refunded || 0), 0)),
            netReceived: r2(txn.amount - txn.allocations.reduce((s, a) => s + (a.refunded || 0), 0)),
            outstandingAfter: outstanding.totalOutstanding
        },
        transactionId: txn._id
    };
};

// ── dashboard summary (cards + charts) ────────────────────────────────────────
const SUMMARY_MONTHS = 6;
const NET_AMOUNT = { $cond: [{ $eq: ['$type', 'refund'] }, { $multiply: ['$amount', -1] }, '$amount'] };
const IS_COLLECTION = { $cond: [{ $eq: ['$type', 'refund'] }, 0, 1] };
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const getPaymentsSummary = async (libraryId, scope = {}) => {
    const { monthRangeIST, todayRangeIST } = require('../utils/time');
    const lib = oid(libraryId);
    const now = new Date();
    const today = todayRangeIST();
    const thisMonth = monthRangeIST(now);
    // month windows, oldest first
    const ranges = [thisMonth];
    for (let i = 1; i < SUMMARY_MONTHS; i += 1) ranges.unshift(monthRangeIST(new Date(ranges[0].start.getTime() - 1)));
    const months = ranges.map((r) => {
        const shifted = new Date(r.start.getTime() + 330 * 60000);
        return { start: r.start, end: r.end, key: shifted.toISOString().slice(0, 7), label: `${MONTH_NAMES[shifted.getUTCMonth()]} ${shifted.getUTCFullYear()}` };
    });
    const policy = await getPolicy(libraryId);
    const overdueBefore = startOfDayIST(new Date(Date.now() - (policy.graceDays || 0) * DAY_MS));
    const txnMatch = { libraryId: lib, status: 'success', paymentDate: { $gte: months[0].start, $lte: thisMonth.end }, ...scope };

    const [txn, dues] = await Promise.all([
        PaymentTransaction.aggregate([
            { $match: txnMatch },
            { $facet: {
                // Collections minus refunds (money actually kept); counts are receipts only
                trend: [
                    { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$paymentDate', timezone: '+05:30' } }, total: { $sum: NET_AMOUNT }, count: { $sum: IS_COLLECTION } } }
                ],
                today: [
                    { $match: { paymentDate: { $gte: today.start, $lte: today.end } } },
                    { $group: { _id: null, total: { $sum: NET_AMOUNT }, count: { $sum: IS_COLLECTION } } }
                ],
                methods: [
                    { $match: { paymentDate: { $gte: thisMonth.start, $lte: thisMonth.end } } },
                    { $group: { _id: '$method', total: { $sum: NET_AMOUNT }, count: { $sum: IS_COLLECTION } } }
                ],
                refunds: [
                    { $match: { type: 'refund', paymentDate: { $gte: thisMonth.start, $lte: thisMonth.end } } },
                    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
                ]
            } }
        ]),
        Payment.aggregate([
            { $match: { libraryId: lib, paymentStatus: { $in: OPEN_STATUSES }, dueAmount: { $gt: 0 }, ...scope } },
            { $group: {
                _id: null,
                due: { $sum: '$dueAmount' }, charges: { $sum: 1 }, students: { $addToSet: '$studentId' },
                overdue: { $sum: { $cond: [{ $lt: ['$dueDate', overdueBefore] }, '$dueAmount', 0] } },
                overdueCount: { $sum: { $cond: [{ $lt: ['$dueDate', overdueBefore] }, 1, 0] } }
            } }
        ])
    ]);
    const f = txn[0] || {};
    const byKey = new Map((f.trend || []).map((t) => [t._id, t]));
    const trend = months.map((m) => ({ key: m.key, label: m.label, total: r2((byKey.get(m.key) || {}).total), count: (byKey.get(m.key) || {}).count || 0 }));
    const one = (arr) => (arr && arr[0]) || { total: 0, count: 0 };
    const d = dues[0] || { due: 0, charges: 0, students: [], overdue: 0, overdueCount: 0 };
    const methods = (f.methods || []).map((m) => ({ method: m._id || 'other', total: r2(m.total), count: m.count })).sort((a, b) => b.total - a.total);
    const cashTotal = methods.filter((m) => m.method === 'cash').reduce((s, m) => s + m.total, 0);
    const monthTotal = trend[trend.length - 1].total;
    return {
        today: { total: r2(one(f.today).total), count: one(f.today).count },
        thisMonth: { total: monthTotal, count: trend[trend.length - 1].count },
        lastMonth: { total: trend[trend.length - 2].total },
        refundsThisMonth: { total: r2(one(f.refunds).total), count: one(f.refunds).count },
        cashThisMonth: r2(cashTotal),
        onlineThisMonth: r2(monthTotal - cashTotal),
        pending: { total: r2(d.due), charges: d.charges, students: d.students.length },
        overdue: { total: r2(d.overdue), charges: d.overdueCount },
        methods,
        trend
    };
};

// ── CSV export of the filtered charges ────────────────────────────────────────
const csvCell = (v) => {
    let s = v == null ? '' : v instanceof Date ? istDateKey(v) : String(v);
    if (/^[=+@\t\r-]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const exportPaymentsCsv = async (libraryId, q, scope, write) => {
    const filter = await buildPaymentFilter(libraryId, q, scope);
    const sort = PAYMENT_SORTS[q.sort] || PAYMENT_SORTS.newest;
    await write('﻿' + ['Billed on', 'Student', 'Mobile', 'Reg. no', 'For', 'Receipts', 'Total', 'Discount', 'Late fee', 'Waived', 'Paid', 'Refunded', 'Due', 'Method', 'Status', 'Due date', 'Last paid on'].map(csvCell).join(',') + '\n');
    const cursor = Payment.find(filter).populate('studentId', 'name mobile rollNumber registrationNumber').populate('planId', 'name').sort(sort).limit(20000).lean().cursor();
    let n = 0;
    for await (const p of cursor) {
        const s = p.studentId || {};
        const receipts = [...new Set((p.allocations || []).map((a) => a.receiptNumber).filter(Boolean))].join(' ');
        await write([
            p.createdAt, s.name, s.mobile, s.registrationNumber || s.rollNumber, p.description || (p.planId && p.planId.name), receipts,
            p.totalAmount, p.discountAmount, p.lateFee, p.waivedAmount, p.paidAmount, p.refundAmount, p.dueAmount,
            p.paymentMethod, p.paymentStatus, p.dueDate, p.paymentDate
        ].map(csvCell).join(',') + '\n');
        n += 1;
    }
    return n;
};

module.exports = {
    getPaymentsSummary,
    exportPaymentsCsv,
    createCharge,
    recordPayment,
    getOutstanding,
    getLibraryOutstanding,
    cancelCharge,
    rollbackCharge,
    refundPayment,
    adjustCharge,
    waiveCharge,
    enforceCreditPolicy,
    createOnlineAttempt,
    claimAttempt,
    failAttempt,
    finalizeOnlineAttempt,
    queryPayments,
    getPaymentById,
    getStudentLedger,
    buildReceipt,
    nextReceiptNo,
    getPolicy,
    refreshStudentPaymentStatus,
    findCollectionByRequestId,
    replayCollection,
    membershipNetOf,
    findMembershipCharge,
    splitPlanChangeCredit,
    applyPlanChangeToOldCharge,
    membershipWarning,
    buildReceiptTax,
    isChargeOverdue,
    hasPermission,
    PERM_KEYS,
    OPEN_STATUSES
};

// ---- Live dashboards (no-op without sockets, never throws) ----
const realtime = require('../realtime/emitters');
const onCollected = ([a], r) => { const t = (r && r.transaction) || {}; realtime.paymentChanged({ libraryId: (a && a.libraryId) || t.libraryId, branchId: t.branchId || null, amount: t.amount, kind: 'collection' }); };
module.exports.recordPayment = realtime.after(module.exports.recordPayment, onCollected);
module.exports.finalizeOnlineAttempt = realtime.after(module.exports.finalizeOnlineAttempt, ([attempt], r) => {
    const t = (r && r.transaction) || {};
    realtime.paymentChanged({ libraryId: (attempt && attempt.libraryId) || t.libraryId, branchId: t.branchId || null, amount: t.amount, kind: 'collection' });
});
module.exports.refundPayment = realtime.after(module.exports.refundPayment, ([a], r) => realtime.paymentChanged({ libraryId: (a && a.libraryId) || (r && r.libraryId), branchId: (r && r.branchId) || null, amount: r && r.amount, kind: 'refund' }));
for (const name of ['createCharge', 'cancelCharge', 'adjustCharge', 'waiveCharge']) {
    module.exports[name] = realtime.after(module.exports[name], ([a], r) => realtime.chargeChanged({ libraryId: (a && a.libraryId) || (r && r.libraryId), branchId: (r && r.branchId) || null }));
}
