const crypto = require('crypto');
const mongoose = require('mongoose');
const Student = require('../models/student.model');
const Plan = require('../models/plan.model');
const Seat = require('../models/seat.model');
const Branch = require('../models/branch.model');
const Library = require('../models/library.model');
const Payment = require('../models/payment.model');
const Counter = require('../models/counter.model');
const MembershipHistory = require('../models/membershipHistory.model');
const ApiError = require('../utils/ApiError');
const pick = require('../utils/pick');
const escapeRegex = require('../utils/escapeRegex');
const audit = require('../utils/audit');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { deriveAadhaar, isValidAadhaar } = require('../utils/aadhaar');
const dpdp = require('../utils/dpdp');
const { normalizeMobile } = require('../utils/mobile');
const { describeRequest } = require('../utils/device');
const { startOfDayIST, endOfDayIST, DAY_MS } = require('../utils/time');
const { computeProration } = require('../utils/feeMath');
const seatService = require('./seat.service');
const planService = require('./plan.service');

const isValidId = (v) => mongoose.Types.ObjectId.isValid(String(v));

// Fields an admin may set when creating / updating a student. Never: password, libraryId,
// planStatus, expiryDate, status, isDeleted, seat pointers, payment flags.
const CREATE_FIELDS = [
    'name', 'email', 'mobile', 'rollNumber', 'dob', 'gender', 'aadhaarNumber', 'aadhaarCardImage',
    'guardianName', 'guardianMobile', 'guardianRelation', 'guardianOccupation', 'emergencyContact', 'documents',
    'address', 'city', 'state', 'country', 'countryCode', 'stateCode', 'pincode',
    'joiningDate', 'branchId', 'profileImage'
];
const UPDATE_FIELDS = CREATE_FIELDS;
const CLEARABLE_FIELDS = ['email', 'gender', 'dob', 'pincode', 'guardianMobile'];

const STATUS_VALUES = ['active', 'inactive', 'leave', 'suspended'];
const MEMBERSHIP_STATUS_VALUES = ['none', 'pending', 'active', 'paused', 'expired'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Lazy, guarded access to the fee ledger (owned by the payments module). */
const getLedger = () => {
    try {
        return require('./feeLedger.service');
    } catch (e) {
        if (e && e.code === 'MODULE_NOT_FOUND' && /feeLedger/.test(e.message)) return null;
        console.error('feeLedger.service failed to load:', e.message);
        return null;
    }
};

const generateTempPassword = () => {
    // 10 chars, unambiguous alphabet
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(10);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};

const nextRegistrationNumber = async (libraryId) => {
    const seq = await Counter.next(`student-reg:${libraryId}`);
    return `REG-${String(seq).padStart(4, '0')}`;
};

const loadStudent = async (id, libraryId) => {
    if (!isValidId(id)) throw new ApiError(404, 'Student not found');
    const student = await Student.findOne({ _id: id, libraryId });
    if (!student) throw new ApiError(404, 'Student not found');
    return student;
};

const loadPlan = async (planId, libraryId, { requireAssignable = true } = {}) => {
    if (!isValidId(planId)) throw new ApiError(404, 'Plan not found');
    const plan = await Plan.findOne({ _id: planId, libraryId });
    if (!plan) throw new ApiError(404, 'Plan not found');
    if (requireAssignable && plan.status === false) {
        throw new ApiError(400, 'This plan is inactive or archived and cannot be assigned');
    }
    return plan;
};

const getPolicy = async (libraryId, req) => {
    let lib = req?.library && String(req.library._id) === String(libraryId) ? req.library : null;
    if (!lib) lib = await Library.findById(libraryId).select('membershipPolicy');
    const p = lib?.membershipPolicy ? (lib.membershipPolicy.toObject ? lib.membershipPolicy.toObject() : lib.membershipPolicy) : {};
    return {
        allowPause: p.allowPause !== false,
        maxPauseDays: p.maxPauseDays ?? 30,
        allowExtend: p.allowExtend !== false,
        maxExtendDays: p.maxExtendDays ?? 30,
        releaseSeatOnPause: !!p.releaseSeatOnPause
    };
};

const mapPaymentMethod = (m) => (m === 'cash' ? 'cash' : m ? 'online' : 'unpaid');

const planAmount = (plan) => (plan.finalPrice ?? Math.max(0, (plan.price || 0) - (plan.discount || 0)));

/** Create a charge in the fee ledger. Returns { pendingCharge, charge }. */
const createPlanCharge = async ({ libraryId, student, plan, amount, joiningFee = 0, deposit = 0, dueDate, periodStart, periodEnd, paymentType, description, couponCode, referrerId, req, extraDiscount = 0, extraDiscountReason }) => {
    const ledger = getLedger();
    if (!ledger || typeof ledger.createCharge !== 'function') return { pendingCharge: false, charge: null };
    if ((Number(amount) || 0) + (Number(joiningFee) || 0) + (Number(deposit) || 0) <= 0) return { pendingCharge: false, charge: null }; // free plan
    const charge = await ledger.createCharge({
        libraryId,
        studentId: student._id,
        planId: plan._id,
        amount,
        joiningFee,
        deposit,
        couponCode,
        referrerId,
        extraDiscount,
        extraDiscountReason,
        skipCreditPolicy: true, // credit policy is enforced when the membership is activated (markAsPaid / assertCreditAllowed)
        dueDate: dueDate || undefined, // ledger default: 7 days

        periodStart,
        periodEnd,
        paymentType,
        description: description || `${plan.name} membership fee`,
        createdBy: req?.user?._id,
        req
    });
    return { pendingCharge: true, charge };
};

const LEDGER_METHODS = ['cash', 'upi', 'online', 'bank_transfer', 'other'];
const ledgerMethod = (m) => (LEDGER_METHODS.includes(m) ? m : 'other');

const money2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** First/last day of a membership started on startDate. Must mirror activateMembership(). */
const membershipWindow = (plan, startDate) => {
    const days = planService.getPlanDurationDays(plan);
    const start = startOfDayIST(startDate ? new Date(startDate) : new Date());
    if (isNaN(start.getTime())) throw new ApiError(400, 'Invalid start date');
    return { start, end: endOfDayIST(new Date(start.getTime() + (days - 1) * DAY_MS)) };
};

/**
 * Credit policy for activating a membership (renew / change plan) while money is still owed.
 *  chargeAmount : what the new charge will be after discounts, paidNow : collected at activation,
 *  relief       : existing dues that are cleared by the same operation (plan-change waiver/cancel)
 */
const assertCreditAllowed = async ({ libraryId, studentId, chargeAmount, paidNow = 0, relief = 0, dueDate }) => {
    const ledger = getLedger();
    if (!ledger || typeof ledger.getPolicy !== 'function') return;
    const remaining = money2(chargeAmount - paidNow);
    if (remaining <= 0.009) return;
    const policy = await ledger.getPolicy(libraryId);
    if (!policy.allowCredit) {
        throw new ApiError(400, `This library does not allow credit: collect ₹${remaining} now to renew or change the plan`);
    }
    await ledger.enforceCreditPolicy({ libraryId, studentId, newDue: money2(remaining - relief), paidNow, dueDate, policy });
};

/** Collect money against the charge just created for a renewal / plan change (needs the fees.collect right). */
const collectAtActivation = async ({ libraryId, student, charge, paidNow, paymentMethod, reference, requestId, req, note }) => {
    const ledger = getLedger();
    if (!ledger.hasPermission(req, ['fees.collect'])) throw new ApiError(403, 'You do not have permission to collect payments');
    return ledger.recordPayment({
        libraryId, studentId: student._id, amount: paidNow, method: ledgerMethod(paymentMethod || 'cash'), reference,
        receivedBy: req?.user?._id, allocations: [{ paymentId: charge._id, amount: paidNow }], trustedAllocation: true,
        collectRequestId: requestId, note, req
    });
};

// ---------------------------------------------------------------------------
// Membership core
// ---------------------------------------------------------------------------
/**
 * Activate a membership for a student on a plan. Computes expiry from the real plan
 * duration (durationDays / durationType), closes any previous live membership, writes
 * a MembershipHistory record and updates the student atomically.
 *
 * opts: { startDate, libraryId, req, expectStatuses, source, paymentMethod, paymentStatus, closeReason }
 */
// Fire-and-forget membership notification (never blocks or fails the business action)
const notifyMembership = (libraryId, student, expiryDate, { activated = false } = {}) => {
    try {
        const day = expiryDate ? new Date(expiryDate).toISOString().slice(0, 10) : '';
        Promise.resolve(require('./notification.service').notifyEvent('renewal', libraryId, {
            studentId: student._id, variables: { expiryDate: day },
            ...(activated ? { title: 'Membership activated', message: `Hi ${student.name || ''}, your membership is active until ${day}.` } : {}),
            data: { type: activated ? 'membership_activated' : 'membership_renewed', expiryDate: day },
            dedupeKey: `${activated ? 'activate' : 'renew'}:${student._id}:${day}`
        })).catch(() => {});
    } catch (_) { /* ignore */ }
};

const activateMembership = async (student, plan, opts = {}) => {
    const { req, expectStatuses, source = 'assign', paymentMethod, paymentStatus, closeReason } = opts;
    const libraryId = opts.libraryId || student.libraryId;

    if (String(student.libraryId) !== String(libraryId) || String(plan.libraryId) !== String(libraryId)) {
        throw new ApiError(400, 'Student and plan must belong to the same library');
    }

    const days = planService.getPlanDurationDays(plan);
    const startDate = startOfDayIST(opts.startDate ? new Date(opts.startDate) : new Date());
    if (isNaN(startDate.getTime())) throw new ApiError(400, 'Invalid start date');
    const endDate = endOfDayIST(new Date(startDate.getTime() + (days - 1) * DAY_MS));

    const filter = { _id: student._id, libraryId, isDeleted: false };
    if (expectStatuses && expectStatuses.length) filter.planStatus = { $in: expectStatuses };

    const $set = { planId: plan._id, planStatus: 'active', planStartDate: startDate, expiryDate: endDate, updatedBy: req?.user?._id };
    if (paymentMethod) $set.paymentMethod = paymentMethod;
    if (paymentStatus) $set.paymentStatus = paymentStatus;

    const updated = await Student.findOneAndUpdate(
        filter,
        { $set, $unset: { membershipPausedAt: '', membershipPauseReason: '' } },
        { new: true }
    );
    if (!updated) throw new ApiError(409, 'Student membership state changed, please refresh and retry');

    // Close previous live membership records (superseded / cancelled)
    const now = new Date();
    await MembershipHistory.updateMany(
        { studentId: student._id, libraryId, status: { $in: ['active', 'paused'] }, endDate: { $lte: now } },
        { $set: { status: 'expired', closedReason: closeReason || 'superseded' } }
    );
    await MembershipHistory.updateMany(
        { studentId: student._id, libraryId, status: { $in: ['active', 'paused'] } },
        { $set: { status: source === 'renewal' ? 'expired' : 'cancelled', closedReason: closeReason || source } }
    );

    const membership = await MembershipHistory.create({
        studentId: student._id,
        libraryId,
        branchId: student.branchId || null,
        planId: plan._id,
        planName: plan.name,
        price: planAmount(plan),
        startDate,
        endDate,
        status: 'active',
        seatId: updated.seatId || null,
        source,
        createdBy: req?.user?._id
    });

    if (req) audit(req, 'membership.activate', 'Student', student._id, { planId: plan._id, plan: plan.name, startDate, endDate, source });
    return { student: updated, membership };
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
const normaliseBody = (body) => {
    const data = pick(body, CREATE_FIELDS);
    if (data.email === '') delete data.email;
    return data;
};

const INDIAN_MOBILE = /^[6-9]\d{9}$/;
const INDIAN_PINCODE = /^[1-9]\d{5}$/;

/** Indian mobile / pincode normalisation + checks on the fields we are about to store (400 on a bad value). */
const normaliseContactFields = (data) => {
    if (data.mobile !== undefined) {
        data.mobile = normalizeMobile(data.mobile);
        if (!INDIAN_MOBILE.test(data.mobile)) throw new ApiError(400, 'Enter a valid 10-digit Indian mobile number (starts with 6-9)');
    }
    if (data.guardianMobile !== undefined) {
        if (data.guardianMobile === '' || data.guardianMobile === null) delete data.guardianMobile;
        else {
            data.guardianMobile = normalizeMobile(data.guardianMobile);
            if (!INDIAN_MOBILE.test(data.guardianMobile)) throw new ApiError(400, 'Guardian mobile must be a valid 10-digit Indian mobile number');
        }
    }
    if (data.pincode !== undefined) {
        if (data.pincode === '' || data.pincode === null) delete data.pincode;
        else if (!INDIAN_PINCODE.test(String(data.pincode).trim())) throw new ApiError(400, 'Pincode must be 6 digits');
    }
};

/**
 * Replace a typed Aadhaar number by its last 4 digits + keyed hash. The full number is dropped here and is
 * never persisted or logged. An empty value leaves the stored Aadhaar untouched ("re-enter to replace").
 */
const applyAadhaar = async (data, libraryId, { excludeId } = {}) => {
    const typed = data.aadhaarNumber;
    delete data.aadhaarNumber;
    if (typed === undefined || typed === null || String(typed).trim() === '') return;
    let derived;
    try {
        derived = deriveAadhaar(typed, libraryId);
    } catch (e) {
        throw new ApiError(400, e.message);
    }
    const dup = await Student.findOne({ libraryId, aadhaarHash: derived.aadhaarHash, ...(excludeId && { _id: { $ne: excludeId } }) }).select('_id');
    if (dup) throw new ApiError(409, 'This Aadhaar number is already registered for another student in this library');
    data.aadhaarLast4 = derived.aadhaarLast4;
    data.aadhaarHash = derived.aadhaarHash;
};

/** DPDP: consent record built from the admission request (who captured it, when, which notice version, from where). */
const buildConsent = async (req) => ({
    given: true,
    givenAt: new Date(),
    // the privacy policy version published at this moment (falls back to the fixed constant if the documents are unavailable)
    version: await require('./legal.service').privacyVersionLabel(dpdp.PRIVACY_POLICY_VERSION),
    purpose: dpdp.CONSENT_PURPOSE,
    capturedBy: req?.user?._id,
    ip: req ? describeRequest(req).ip : undefined
});

/** Under-18 students need their guardian's name, mobile and recorded consent. */
const assertMinorRules = (dob, { guardianName, guardianMobile, guardianConsentGiven }) => {
    if (!dob || !dpdp.isMinor(dob)) return;
    const issues = dpdp.minorGuardianIssues({ name: guardianName, mobile: guardianMobile, consentGiven: guardianConsentGiven });
    if (issues.length) throw new ApiError(400, issues.map((i) => i.message).join('; '));
};

const validateBranch = async (branchId, libraryId) => {
    if (!branchId) return null;
    if (!isValidId(branchId)) throw new ApiError(400, 'Invalid branch');
    const branch = await Branch.findOne({ _id: branchId, libraryId, isDeleted: { $ne: true } }).select('_id');
    if (!branch) throw new ApiError(400, 'Branch does not belong to this library');
    return branch._id;
};

/**
 * Undo a half-finished registration (seat/plan step failed): free the seat and delete the just-created student.
 * Never deletes anything once a fee charge exists; returns false then so the caller can keep the student.
 */
const rollbackRegistration = async (student, libraryId, req) => {
    try {
        if (await Payment.exists({ studentId: student._id, libraryId })) return false;
        await seatService.releaseSeatForStudent(student._id, libraryId, { actor: seatService.actorOf(req), reason: 'Registration rolled back' }).catch(() => {});
        await MembershipHistory.deleteMany({ studentId: student._id, libraryId });
        await Student.deleteOne({ _id: student._id, libraryId });
        return true;
    } catch (e) {
        console.error('[student] registration rollback failed for', String(student._id), e.message);
        return false;
    }
};

const registerStudent = async (libraryId, body, req) => {
    const data = normaliseBody(body);
    normaliseContactFields(data);

    // DPDP: consent is mandatory at admission; a minor also needs the guardian's details and consent
    if (!dpdp.toBool(body.consentGiven)) throw new ApiError(400, "The student's consent to data processing is required");
    const guardianConsentGiven = dpdp.toBool(body.guardianConsentGiven);
    assertMinorRules(data.dob, { guardianName: data.guardianName, guardianMobile: data.guardianMobile, guardianConsentGiven });
    data.consent = await buildConsent(req);
    if (guardianConsentGiven) data.guardianConsent = { given: true, givenAt: new Date() };
    await applyAadhaar(data, libraryId);

    // Subscription limit
    const library = await Library.findById(libraryId).select('planLimits');
    if (!library) throw new ApiError(404, 'Library not found');
    const maxStudents = library.planLimits?.maxStudents ?? 100;
    const currentCount = await Student.countDocuments({ libraryId, isDeleted: false });
    if (currentCount >= maxStudents) {
        throw new ApiError(403, `Student limit reached (${maxStudents}). Upgrade your subscription plan to add more students.`);
    }

    if (await Student.findOne({ libraryId, mobile: data.mobile })) {
        throw new ApiError(409, 'A student with this mobile number already exists in this library');
    }

    if (data.branchId) data.branchId = await validateBranch(data.branchId, libraryId);

    // Validate optional plan / seat up-front so we fail before creating anything
    const plan = body.planId ? await loadPlan(body.planId, libraryId) : null;
    let seat = null;
    if (body.seatId) {
        if (!isValidId(body.seatId)) throw new ApiError(404, 'Seat not found');
        seat = await Seat.findOne({ _id: body.seatId, libraryId });
        if (!seat) throw new ApiError(404, 'Seat not found');
        if (seat.status !== 'available') throw new ApiError(400, `Seat is ${seat.status}`);
        if (plan && !seatService.isSeatTypeEligible(plan, seat)) throw new ApiError(400, `Plan "${plan.name}" is not eligible for ${seat.type} seats`);
        if (data.branchId && seat.branchId && String(data.branchId) !== String(seat.branchId)) throw new ApiError(400, 'Seat belongs to a different branch than the student');
        if (!data.branchId && seat.branchId) data.branchId = seat.branchId;
    }

    // Credentials: provided password or generated temp password; always force a change
    const generated = !body.password;
    const plainPassword = body.password || generateTempPassword();

    const registrationNumber = await nextRegistrationNumber(libraryId);
    let student;
    try {
        student = await Student.create({
            ...data,
            libraryId,
            registrationNumber,
            password: plainPassword,
            mustChangePassword: true,
            planStatus: 'none',
            createdBy: req?.user?._id
        });
    } catch (e) {
        if (e && e.code === 11000) throw new ApiError(409, 'A student with this mobile number already exists in this library');
        throw e;
    }

    // The limit check above is count-then-insert; re-check after the insert so concurrent admissions cannot overshoot
    if (await Student.countDocuments({ libraryId, isDeleted: false }) > maxStudents) {
        await Student.deleteOne({ _id: student._id, libraryId });
        throw new ApiError(403, `Student limit reached (${maxStudents}). Upgrade your subscription plan to add more students.`);
    }

    // A requested seat / plan that cannot be applied undoes the admission instead of leaving a half-set-up student
    const warnings = [];
    const failRegistration = async (what, e) => {
        const undone = await rollbackRegistration(student, libraryId, req);
        if (undone) throw new ApiError(e.statusCode || 400, `Student was not created. ${what} could not be assigned: ${e.message}`);
        warnings.push(`${what} could not be assigned: ${e.message}`);
    };

    let seatAssigned = null;
    if (seat) {
        try {
            seatAssigned = await seatService.assignSeat(seat._id, student._id, libraryId, seatService.actorOf(req));
        } catch (e) {
            await failRegistration('Seat', e);
        }
    }

    let planResult = null;
    if (plan) {
        try {
            planResult = await assignPlan(student._id, libraryId, { planId: plan._id, joiningDate: data.joiningDate, dueDate: body.dueDate, couponCode: body.couponCode, referrerId: body.referrerId }, req, { skipAudit: true });
        } catch (e) {
            await failRegistration('Plan', e);
        }
    }

    if (req) audit(req, 'student.create', 'Student', student._id, { registrationNumber, mobile: student.mobile });

    const fresh = await Student.findById(student._id);
    return {
        student: fresh || student,
        credentials: generated ? { tempPassword: plainPassword, mustChangePassword: true } : undefined,
        seat: seatAssigned,
        pendingCharge: planResult ? planResult.pendingCharge : false,
        warnings
    };
};

// ---------------------------------------------------------------------------
// Plan assignment / payment / renewal
// ---------------------------------------------------------------------------
/** Assign a plan (status: pending until the first payment is recorded). */
const assignPlan = async (studentId, libraryId, { planId, joiningDate, dueDate, couponCode, referrerId }, req, { skipAudit = false } = {}) => {
    const student = await loadStudent(studentId, libraryId);
    if (student.status === 'suspended' || student.status === 'inactive') {
        throw new ApiError(400, `Cannot assign a plan to a ${student.status} student`);
    }
    if (student.planId && ['active', 'paused', 'pending'].includes(student.planStatus)) {
        throw new ApiError(400, `This student already has a plan with status: ${student.planStatus}. Use change-plan or renew instead.`);
    }

    const plan = await loadPlan(planId, libraryId);

    if (student.seatId) {
        const seat = await Seat.findOne({ _id: student.seatId, libraryId });
        if (seat && !seatService.isSeatTypeEligible(plan, seat)) {
            throw new ApiError(400, `Plan "${plan.name}" is not eligible for the student's ${seat.type} seat`);
        }
    }

    const update = { planId: plan._id, planStatus: 'pending', paymentStatus: 'pending', paymentMethod: 'unpaid', updatedBy: req?.user?._id };
    if (joiningDate) update.joiningDate = new Date(joiningDate);

    const updated = await Student.findOneAndUpdate(
        { _id: student._id, libraryId, isDeleted: false, planStatus: { $in: ['none', 'expired'] } },
        { $set: update },
        { new: true }
    );
    if (!updated) throw new ApiError(409, 'Student plan state changed, please refresh and retry');

    // First membership => also charge the one-time joining fee
    const previous = await MembershipHistory.countDocuments({ studentId: student._id, libraryId });
    const amount = planAmount(plan);
    const periodStart = startOfDayIST(update.joiningDate || new Date());
    let pendingCharge = false;
    let charge = null;
    try {
        ({ pendingCharge, charge } = await createPlanCharge({
            libraryId, student: updated, plan, amount,
            joiningFee: previous === 0 ? (plan.joiningFee || 0) : 0,
            deposit: previous === 0 ? (plan.depositAmount || 0) : 0,
            couponCode, referrerId,
            dueDate: dueDate ? new Date(dueDate) : undefined, periodStart,
            periodEnd: endOfDayIST(new Date(periodStart.getTime() + (planService.getPlanDurationDays(plan) - 1) * DAY_MS)),
            description: `${plan.name} membership fee`, req
        }));
    } catch (e) {
        // Roll the assignment back so the student is not left pending without a charge
        await Student.updateOne({ _id: student._id, libraryId, planStatus: 'pending' }, { $set: { planStatus: student.planStatus, planId: student.planId || null, paymentStatus: student.paymentStatus } });
        throw e;
    }

    if (!skipAudit && req) audit(req, 'student.assign_plan', 'Student', student._id, { planId: plan._id, amount });
    return { student: updated, pendingCharge, charge, amount };
};

/** Record a payment. Activates a pending membership; or settles a charge on an already active one. */
const markAsPaid = async (studentId, libraryId, paymentData, req) => {
    const student = await loadStudent(studentId, libraryId);
    const ledger = getLedger();
    const hasLedger = !!(ledger && typeof ledger.recordPayment === 'function');
    const requestId = paymentData.requestId || undefined;
    // Replay of a payment that already went through (double click / network retry): return the original receipt
    if (hasLedger && requestId) {
        const prev = await ledger.findCollectionByRequestId(libraryId, requestId);
        if (prev) {
            if (String(prev.studentId) !== String(student._id)) throw new ApiError(409, 'This request id was already used for a different student');
            if (prev.status !== 'success') throw new ApiError(409, 'This payment request is already being processed, please wait a moment');
            const outstandingAfter = (await ledger.getOutstanding(libraryId, student._id)).totalOutstanding;
            return {
                student, membership: undefined, paymentRecorded: true, replay: true,
                payment: { transaction: prev, receiptNumber: prev.receiptNumber, allocations: prev.allocations, outstandingAfter, replay: true }
            };
        }
    }
    if (!student.planId) throw new ApiError(400, 'No plan assigned to this student');
    const plan = await loadPlan(student.planId, libraryId, { requireAssignable: false });

    const isPending = student.planStatus === 'pending';
    let outstanding = null;
    if (hasLedger) outstanding = (await ledger.getOutstanding(libraryId, student._id)).totalOutstanding;
    const settlingActive = ['active', 'paused'].includes(student.planStatus) &&
        (hasLedger ? outstanding > 0 : student.paymentStatus === 'pending');
    if (!isPending && !settlingActive) throw new ApiError(400, 'There is no pending payment for this student');

    const method = paymentData.paymentMethod || 'cash';
    // amount 0 = activate on credit (pay later); omitted = pay everything outstanding
    const amount = paymentData.amount ?? (hasLedger ? outstanding : planAmount(plan));
    if (hasLedger && outstanding > 0 && amount > outstanding) {
        throw new ApiError(400, `Payment of ${amount} exceeds outstanding ${outstanding}`);
    }
    if (amount === 0 && !isPending) throw new ApiError(400, 'Payment amount must be greater than 0');

    // Credit policy (spec 15.2): activating a membership while money is still owed is credit
    if (hasLedger && isPending && outstanding > 0) {
        const remaining = Math.round((outstanding - amount) * 100) / 100;
        if (remaining > 0.009) {
            const policy = await ledger.getPolicy(libraryId);
            if (!policy.allowCredit) {
                throw new ApiError(400, 'This library does not allow credit: the full amount must be paid to activate the membership');
            }
            if (policy.maxCreditAmount > 0 && remaining > policy.maxCreditAmount) {
                throw new ApiError(400, `Credit limit exceeded: ₹${remaining} would remain unpaid (max credit ₹${policy.maxCreditAmount})`);
            }
            if (policy.maxCreditDays > 0) {
                const out = await ledger.getOutstanding(libraryId, student._id);
                const tooLong = out.charges.some((c) => c.dueDate && (new Date(c.dueDate).getTime() - Date.now()) / DAY_MS > policy.maxCreditDays);
                if (tooLong) throw new ApiError(400, `A due date is beyond the maximum credit period of ${policy.maxCreditDays} day(s)`);
            }
        }
    }

    let result;
    if (isPending) {
        result = await activateMembership(student, plan, {
            libraryId, req, source: 'assign', expectStatuses: ['pending'],
            startDate: paymentData.startDate || new Date(),
            paymentMethod: mapPaymentMethod(method),
            // With a ledger the ledger decides paid/pending after allocating the payment
            paymentStatus: hasLedger ? 'pending' : 'paid'
        });
    } else {
        const upd = await Student.findOneAndUpdate(
            { _id: student._id, libraryId },
            { $set: { paymentMethod: mapPaymentMethod(method), ...(hasLedger ? {} : { paymentStatus: 'paid' }), updatedBy: req?.user?._id } },
            { new: true }
        );
        result = { student: upd };
    }

    let payment = null;
    let paymentRecorded = false;
    if (hasLedger && outstanding > 0 && amount > 0) {
        try {
            payment = await ledger.recordPayment({
                libraryId,
                studentId: student._id,
                amount,
                method: ledgerMethod(method),
                reference: paymentData.transactionId,
                note: paymentData.remarks || 'Payment received, plan activated',
                receivedBy: req?.user?._id,
                collectRequestId: requestId,
                req
            });
            paymentRecorded = true;
        } catch (e) {
            if (isPending && result.membership) {
                // Undo the activation so membership and money stay consistent
                await Student.updateOne({ _id: student._id, libraryId, planStatus: 'active' }, { $set: { planStatus: 'pending', paymentStatus: 'pending' }, $unset: { expiryDate: '', planStartDate: '' } });
                await MembershipHistory.updateOne({ _id: result.membership._id }, { $set: { status: 'cancelled', closedReason: 'payment_failed' } });
            }
            throw e;
        }
    }

    if (req) audit(req, 'student.mark_paid', 'Student', student._id, { planId: plan._id, method, amount, paymentRecorded });
    if (isPending && result.student) notifyMembership(libraryId, result.student, result.student.expiryDate, { activated: true });
    return { ...result, payment, paymentRecorded };
};

/**
 * Move an existing member to another plan (takes effect immediately).
 * Fees are prorated: the unused part of the current plan (whole days left, counted from the new start date) is
 * credited. It first reduces what is still owed on the old charge (cancelled when nothing was used or paid, otherwise
 * waived); the rest becomes a discount on the new charge. Money already paid is never moved or refunded
 * automatically - if the credit exceeds the new price the surplus is reported as `creditLeftover` (refund it from Payments).
 * Optional paidNow collects part/all of the new charge at once; without it the library's credit policy must allow the due.
 */
const changePlan = async (studentId, libraryId, { planId, startDate, reason, paidNow = 0, paymentMethod, reference, requestId }, req) => {
    const student = await loadStudent(studentId, libraryId);
    if (!student.planId || !['active', 'paused', 'pending', 'expired'].includes(student.planStatus)) {
        throw new ApiError(400, 'Student has no plan to change. Assign a plan first.');
    }
    if (String(student.planId) === String(planId) && student.planStatus === 'active') {
        throw new ApiError(400, 'Student is already on this plan');
    }
    const plan = await loadPlan(planId, libraryId);
    if (student.seatId) {
        const seat = await Seat.findOne({ _id: student.seatId, libraryId });
        if (seat && !seatService.isSeatTypeEligible(plan, seat)) {
            throw new ApiError(400, `Plan "${plan.name}" is not eligible for the student's ${seat.type} seat`);
        }
    }

    const ledger = getLedger();
    const window = membershipWindow(plan, startDate || new Date());

    // 1. Credit for the unused part of the current plan
    let oldCharge = null;
    let proration = { oldChargeId: null, totalDays: 0, remainingDays: 0, credit: 0 };
    let split = { cancelOld: false, waiveOld: 0, discountNew: 0 };
    if (ledger && student.planStatus !== 'expired') {
        oldCharge = await ledger.findMembershipCharge(libraryId, student._id, student.planId, new Date());
        if (oldCharge) {
            const net = ledger.membershipNetOf(oldCharge);
            const pr = student.planStatus === 'pending'
                ? { totalDays: 0, remainingDays: 0, credit: net } // never started: nothing was used
                : computeProration({ netAmount: net, periodStart: oldCharge.periodStart, periodEnd: oldCharge.periodEnd, asOf: window.start });
            proration = { oldChargeId: oldCharge._id, ...pr };
            split = ledger.splitPlanChangeCredit({ credit: pr.credit, dueAmount: oldCharge.dueAmount, paidAmount: oldCharge.paidAmount, membershipNet: net });
        }
    }

    // 2. New charge = price - credit left after the old charge was settled (never below zero)
    const price = planAmount(plan);
    const newDiscount = money2(Math.min(split.discountNew, price));
    const chargeAmount = money2(price - newDiscount);
    const creditLeftover = money2(split.discountNew - newDiscount);
    const paid = money2(Math.max(0, Number(paidNow) || 0));
    if (paid > chargeAmount + 0.009) throw new ApiError(400, `Amount collected ₹${paid} is more than the new charge ₹${chargeAmount}`);
    const relief = split.cancelOld ? (oldCharge?.dueAmount || 0) : split.waiveOld;
    await assertCreditAllowed({ libraryId, studentId: student._id, chargeAmount, paidNow: paid, relief });

    const creditReason = `Plan change: unused period of the previous plan${reason ? ` (${reason})` : ''}`;
    let pendingCharge = false;
    let charge = null;
    if (chargeAmount > 0) {
        ({ pendingCharge, charge } = await createPlanCharge({
            libraryId, student, plan, amount: price, extraDiscount: newDiscount, extraDiscountReason: creditReason,
            periodStart: window.start, periodEnd: window.end, description: `${plan.name} plan change fee`, req
        }));
    }

    // 3. Take the money (if any), then switch the membership; a failure before the switch voids the new charge
    let payment = null;
    try {
        if (charge && paid > 0) {
            payment = await collectAtActivation({ libraryId, student, charge, paidNow: paid, paymentMethod, reference, requestId, req, note: 'Paid at plan change' });
        }
    } catch (e) {
        if (charge) await ledger.rollbackCharge(libraryId, charge._id, `Plan change failed: ${e.message}`);
        throw e;
    }
    let result;
    try {
        result = await activateMembership(student, plan, {
            libraryId, req, source: 'plan_change', startDate: startDate || new Date(),
            closeReason: reason || 'plan_change', paymentStatus: 'pending', paymentMethod: 'unpaid'
        });
    } catch (e) {
        if (charge && !payment) await ledger.rollbackCharge(libraryId, charge._id, `Plan change failed: ${e.message}`);
        throw e;
    }

    // 4. Settle the old charge
    const warnings = [];
    if (oldCharge && (split.cancelOld || split.waiveOld > 0)) {
        try {
            await ledger.applyPlanChangeToOldCharge({ libraryId, charge: oldCharge, split, reason: creditReason, req, userId: req?.user?._id });
        } catch (e) {
            console.error('[changePlan] could not settle the old charge:', e.message);
            warnings.push(`The previous plan's fee could not be adjusted automatically (${e.message}). Cancel or waive it manually to avoid double billing.`);
        }
    }
    if (ledger) await ledger.refreshStudentPaymentStatus(libraryId, student._id);

    if (req) audit(req, 'student.change_plan', 'Student', student._id, {
        from: student.planId, to: plan._id, reason, credit: proration.credit, waivedOld: split.waiveOld, cancelledOld: split.cancelOld, discountNew: newDiscount, creditLeftover
    });
    return {
        ...result, pendingCharge, charge, payment, warnings,
        proration: { ...proration, cancelledOld: split.cancelOld, waivedFromOld: split.waiveOld, discountOnNew: newDiscount, creditLeftover, newCharge: chargeAmount }
    };
};

/** Renew a membership, keeping the seat when it is still held or free. */
const renewMembership = async (studentId, libraryId, { planId, startDate, keepSeat = true, dueDate, couponCode, referrerId, paidNow = 0, paymentMethod, reference, requestId }, req) => {
    const student = await loadStudent(studentId, libraryId);
    const targetPlanId = planId || student.planId;
    if (!targetPlanId) throw new ApiError(400, 'No plan to renew. Provide a planId.');
    if (['pending', 'paused'].includes(student.planStatus)) {
        throw new ApiError(400, `Cannot renew a membership that is ${student.planStatus}`);
    }
    const plan = await loadPlan(targetPlanId, libraryId);
    let couponDiscount = 0;
    if (couponCode) {
        // fail before any state changes if the coupon is unusable
        const v = await require('./coupon.service').validateCoupon({ code: couponCode, amount: planAmount(plan), planId: plan._id, studentId: student._id, libraryId, referrerId });
        couponDiscount = Number(v?.discountAmount) || 0;
    }
    if (plan.allowRenewal === false) throw new ApiError(400, `Plan "${plan.name}" does not allow renewal`);
    const chargeAmount = money2(Math.max(0, planAmount(plan) - couponDiscount));
    const paid = money2(Math.max(0, Number(paidNow) || 0));
    if (paid > chargeAmount + 0.009) throw new ApiError(400, `Amount collected ₹${paid} is more than the renewal fee ₹${chargeAmount}`);
    // Credit policy first: reject before the seat or membership is touched
    await assertCreditAllowed({ libraryId, studentId: student._id, chargeAmount, paidNow: paid, dueDate });

    const now = new Date();
    let start = startDate ? new Date(startDate) : now;
    // Renewing an active, not-yet-ended membership starts the day after it ends
    if (!startDate && student.planStatus === 'active' && student.expiryDate && student.expiryDate > now) {
        start = new Date(student.expiryDate.getTime() + 1);
    }

    // Try to get the previous seat back if the student no longer holds one
    let seatNote = null;
    if (keepSeat && !student.seatId) {
        const last = await MembershipHistory.findOne({ studentId: student._id, libraryId, seatId: { $ne: null } }).sort({ endDate: -1 });
        if (last?.seatId) {
            try {
                await seatService.assignSeat(last.seatId, student._id, libraryId, seatService.actorOf(req));
                seatNote = 'previous seat re-assigned';
            } catch (e) {
                seatNote = `previous seat not available: ${e.message}`;
            }
        }
    }
    // "Keep seat" unticked: the student gives their seat up with this renewal
    if (!keepSeat && student.seatId) {
        await seatService.releaseSeatForStudent(student._id, libraryId, { actor: seatService.actorOf(req), reason: 'Seat not kept at renewal' });
    }
    const fresh = await Student.findOne({ _id: student._id, libraryId });

    // Charge (and optional payment) first, then switch the membership; a failure before the switch voids the charge
    const window = membershipWindow(plan, start);
    const { pendingCharge, charge } = await createPlanCharge({
        libraryId, student: fresh, plan, amount: planAmount(plan),
        dueDate: dueDate ? new Date(dueDate) : undefined, couponCode, referrerId,
        periodStart: window.start, periodEnd: window.end,
        paymentType: 'renewal', description: `${plan.name} renewal`, req
    });
    const ledger = getLedger();
    let payment = null;
    try {
        if (charge && paid > 0) {
            payment = await collectAtActivation({ libraryId, student: fresh, charge, paidNow: paid, paymentMethod, reference, requestId, req, note: 'Paid at renewal' });
        }
    } catch (e) {
        if (charge) await ledger.rollbackCharge(libraryId, charge._id, `Renewal failed: ${e.message}`);
        throw e;
    }
    let result;
    try {
        result = await activateMembership(fresh, plan, {
            libraryId, req, source: 'renewal', startDate: start,
            closeReason: 'renewed', paymentStatus: 'pending', paymentMethod: 'unpaid'
        });
    } catch (e) {
        if (charge && !payment) await ledger.rollbackCharge(libraryId, charge._id, `Renewal failed: ${e.message}`);
        throw e;
    }
    if (ledger && charge) await ledger.refreshStudentPaymentStatus(libraryId, student._id);
    if (req) audit(req, 'student.renew', 'Student', student._id, { planId: plan._id, seatNote });
    if (result.student) notifyMembership(libraryId, result.student, result.student.expiryDate);
    return { ...result, pendingCharge, charge, payment, seatNote };
};

// ---------------------------------------------------------------------------
// Pause / resume / extend
// ---------------------------------------------------------------------------
const pauseMembership = async (studentId, libraryId, { reason }, req) => {
    const student = await loadStudent(studentId, libraryId);
    const policy = await getPolicy(libraryId, req);
    if (!policy.allowPause) throw new ApiError(403, 'Membership pause is disabled for this library');
    if (student.planStatus !== 'active') throw new ApiError(400, 'Only an active membership can be paused');
    if (student.expiryDate && student.expiryDate <= new Date()) throw new ApiError(400, 'Membership has already ended');

    const now = new Date();
    const updated = await Student.findOneAndUpdate(
        { _id: student._id, libraryId, planStatus: 'active' },
        { $set: { planStatus: 'paused', membershipPausedAt: now, membershipPauseReason: reason, updatedBy: req?.user?._id } },
        { new: true }
    );
    if (!updated) throw new ApiError(409, 'Membership state changed, please retry');

    const activeHist = await MembershipHistory.findOne({ studentId: student._id, libraryId, status: 'active' }).sort({ startDate: -1 });
    if (activeHist) {
        activeHist.status = 'paused';
        activeHist.pausedAt = now;
        activeHist.pauseReason = reason;
        await activeHist.save();
    }
    if (policy.releaseSeatOnPause) {
        await seatService.releaseSeatForStudent(student._id, libraryId, { actor: seatService.actorOf(req), reason: 'Membership paused' });
    }
    if (req) audit(req, 'membership.pause', 'Student', student._id, { reason });
    return updated;
};

/** Resume a paused membership; credited pause days (capped by policy) extend the expiry. */
const resumeMembership = async (studentId, libraryId, { reason } = {}, req, { policy } = {}) => {
    const student = await loadStudent(studentId, libraryId);
    if (student.planStatus !== 'paused') throw new ApiError(400, 'Membership is not paused');
    const pol = policy || await getPolicy(libraryId, req);

    const now = new Date();
    const pausedAt = student.membershipPausedAt || now;
    const pausedDays = Math.max(0, Math.ceil((now - pausedAt) / DAY_MS));
    const credited = Math.min(pausedDays, pol.maxPauseDays);
    const newExpiry = student.expiryDate ? endOfDayIST(new Date(student.expiryDate.getTime() + credited * DAY_MS)) : null;

    const $set = { planStatus: 'active', updatedBy: req?.user?._id };
    if (newExpiry) $set.expiryDate = newExpiry;
    const updated = await Student.findOneAndUpdate(
        { _id: student._id, libraryId, planStatus: 'paused' },
        { $set, $unset: { membershipPausedAt: '', membershipPauseReason: '' } },
        { new: true }
    );
    if (!updated) throw new ApiError(409, 'Membership state changed, please retry');

    const hist = await MembershipHistory.findOne({ studentId: student._id, libraryId, status: 'paused' }).sort({ startDate: -1 });
    if (hist) {
        hist.status = 'active';
        hist.pausedAt = undefined;
        hist.totalPausedDays = (hist.totalPausedDays || 0) + credited;
        if (newExpiry) hist.endDate = newExpiry;
        await hist.save();
    }

    // Re-seat the student if the seat was released during the pause
    let seatNote = null;
    if (!updated.seatId && hist?.seatId) {
        try {
            await seatService.assignSeat(hist.seatId, student._id, libraryId, seatService.actorOf(req));
        } catch (e) { seatNote = `previous seat not available: ${e.message}`; }
    }
    if (req) audit(req, 'membership.resume', 'Student', student._id, { reason, pausedDays, credited });
    return { student: updated, pausedDays, creditedDays: credited, seatNote };
};

const extendMembership = async (studentId, libraryId, { days, reason }, req) => {
    const student = await loadStudent(studentId, libraryId);
    const policy = await getPolicy(libraryId, req);
    if (!policy.allowExtend) throw new ApiError(403, 'Membership extension is disabled for this library');
    if (days > policy.maxExtendDays) throw new ApiError(400, `Extension cannot exceed ${policy.maxExtendDays} days`);
    if (!['active', 'paused'].includes(student.planStatus) || !student.expiryDate) {
        throw new ApiError(400, 'Only an active or paused membership can be extended. Use renew for expired members.');
    }

    const previous = student.expiryDate;
    const newExpiry = endOfDayIST(new Date(previous.getTime() + days * DAY_MS));
    const updated = await Student.findOneAndUpdate(
        { _id: student._id, libraryId, planStatus: { $in: ['active', 'paused'] }, expiryDate: previous },
        { $set: { expiryDate: newExpiry, updatedBy: req?.user?._id } },
        { new: true }
    );
    if (!updated) throw new ApiError(409, 'Membership changed, please retry');

    const liveHist = await MembershipHistory.findOne({ studentId: student._id, libraryId, status: { $in: ['active', 'paused'] } }).sort({ startDate: -1 });
    if (liveHist) {
        liveHist.endDate = newExpiry;
        liveHist.extensions.push({ days, reason, previousEndDate: previous, newEndDate: newExpiry, by: req?.user?._id, at: new Date() });
        await liveHist.save();
    }
    if (req) audit(req, 'membership.extend', 'Student', student._id, { days, reason, previous, newExpiry });
    return updated;
};

const getMemberships = async (studentId, libraryId) => {
    await loadStudent(studentId, libraryId);
    return MembershipHistory.find({ studentId, libraryId })
        .populate('planId', 'name durationType durationDays')
        .populate('seatId', 'seatNumber')
        .sort({ startDate: -1 });
};

// ---------------------------------------------------------------------------
// Status / notes / credentials
// ---------------------------------------------------------------------------
const setStatus = async (studentId, libraryId, { status, reason, leaveUntil, releaseSeat }, req) => {
    const student = await loadStudent(studentId, libraryId);
    if (!STATUS_VALUES.includes(status)) throw new ApiError(400, 'Invalid status');
    if (student.status === status) throw new ApiError(400, `Student is already ${status}`);

    const $set = { status, statusReason: reason || '', statusChangedAt: new Date(), updatedBy: req?.user?._id };
    const update = { $set };
    if (status === 'leave' && leaveUntil) $set.leaveUntil = new Date(leaveUntil);
    if (status !== 'leave') update.$unset = { leaveUntil: '' };
    const updated = await Student.findOneAndUpdate({ _id: student._id, libraryId }, update, { new: true });

    if (releaseSeat) {
        await seatService.releaseSeatForStudent(student._id, libraryId, { actor: seatService.actorOf(req), reason: `Student marked ${status}` });
    }
    if (req) audit(req, 'student.status', 'Student', student._id, { from: student.status, to: status, reason, leaveUntil, releaseSeat: !!releaseSeat });
    return updated;
};

const addNote = async (studentId, libraryId, text, req) => {
    await loadStudent(studentId, libraryId);
    const note = { text: String(text).trim(), createdBy: req.user._id, createdByName: req.user.name, createdAt: new Date() };
    const updated = await Student.findOneAndUpdate({ _id: studentId, libraryId }, { $push: { notes: note } }, { new: true }).select('notes');
    audit(req, 'student.note', 'Student', studentId, {});
    return updated.notes[updated.notes.length - 1];
};

const getNotes = async (studentId, libraryId) => {
    if (!isValidId(studentId)) throw new ApiError(404, 'Student not found');
    const s = await Student.findOne({ _id: studentId, libraryId }).select('notes');
    if (!s) throw new ApiError(404, 'Student not found');
    return [...s.notes].sort((a, b) => b.createdAt - a.createdAt);
};

/** Admin resets a student's password to a fresh temp password (returned once). */
const resetPassword = async (studentId, libraryId, req) => {
    const student = await loadStudent(studentId, libraryId);
    const tempPassword = generateTempPassword();
    student.password = tempPassword;
    student.mustChangePassword = true;
    student.tokensValidAfter = new Date(); // invalidate every session issued before the reset
    await student.save();
    await require('./session.service').revokeAllForUser(student._id, 'password_reset');
    audit(req, 'student.reset_password', 'Student', student._id, {});
    return { tempPassword, mustChangePassword: true };
};

const changeStudentPassword = async (studentId, currentPassword, newPassword) => {
    const student = await Student.findById(studentId);
    if (!student) throw new ApiError(404, 'Student not found');
    if (!currentPassword) throw new ApiError(400, 'Current password is required');
    if (!(await student.comparePassword(currentPassword))) throw new ApiError(401, 'Current password does not match');
    if (currentPassword === newPassword) throw new ApiError(400, 'New password must be different from the current password');

    student.password = newPassword;
    student.mustChangePassword = false;
    await student.save();
    return true;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
// `scope` = branch filter fragment from utils/branchScope.branchFilter(req); it overrides q.branchId
const buildStudentFilter = (libraryId, q = {}, scope = {}) => {
    const filter = { libraryId, isDeleted: false };
    if (q.status && STATUS_VALUES.includes(String(q.status).toLowerCase())) filter.status = String(q.status).toLowerCase();
    if (q.membershipStatus && MEMBERSHIP_STATUS_VALUES.includes(String(q.membershipStatus).toLowerCase())) {
        filter.planStatus = String(q.membershipStatus).toLowerCase();
    }
    if (q.branchId && isValidId(q.branchId)) filter.branchId = new mongoose.Types.ObjectId(String(q.branchId));
    if (q.planId && isValidId(q.planId)) filter.planId = new mongoose.Types.ObjectId(String(q.planId));
    if (q.gender && ['Male', 'Female', 'Other'].includes(q.gender)) filter.gender = q.gender;
    if (q.hasSeat === 'yes') filter.seatId = { $ne: null };
    if (q.hasSeat === 'no') filter.seatId = null;
    // memberships ending within the next N days (7 or 30), still active
    const exp = parseInt(q.expiringInDays, 10);
    if (exp > 0 && exp <= 90) filter.expiryDate = { $gte: new Date(), $lte: new Date(Date.now() + exp * DAY_MS) };
    // joined between two IST calendar days (YYYY-MM-DD)
    const dayOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    if (dayOk(q.joinedFrom) || dayOk(q.joinedTo)) {
        filter.joiningDate = { ...(dayOk(q.joinedFrom) && { $gte: startOfDayIST(q.joinedFrom) }), ...(dayOk(q.joinedTo) && { $lte: endOfDayIST(q.joinedTo) }) };
    }
    if (q.search) {
        const text = String(q.search).trim();
        const rx = { $regex: escapeRegex(text), $options: 'i' };
        filter.$or = [
            { name: rx }, { mobile: rx }, { email: rx },
            { registrationNumber: rx }, { rollNumber: rx }, { seatNumber: rx }
        ];
        // the list shows "+91 98765 43210": a pasted number must still find the stored 10 digits
        if (/^\+?[\d\s-]+$/.test(text)) {
            const digits = text.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
            if (digits) filter.$or.push({ mobile: { $regex: escapeRegex(digits) } });
        }
    }
    Object.assign(filter, scope);
    return filter;
};

const SORTS = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, name: { name: 1 }, expiry: { expiryDate: 1 }, joining: { joiningDate: -1 } };

const queryStudents = async (libraryId, q = {}, scope = {}) => {
    const page = Math.max(parseInt(q.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(q.limit) || 10, 1), 100);
    const filter = buildStudentFilter(libraryId, q, scope);

    const [students, totalResults] = await Promise.all([
        Student.find(filter)
            .select('-notes')
            .populate('planId', 'name price finalPrice durationType durationDays')
            .populate('branchId', 'name')
            .sort({ ...(SORTS[q.sort] || SORTS.newest), _id: -1 })
            .skip((page - 1) * limit)
            .limit(limit),
        Student.countDocuments(filter)
    ]);

    // one pass for every header number (status, membership, expiring soon, unseated)
    const base = { libraryId: new mongoose.Types.ObjectId(String(libraryId)), isDeleted: false, ...scope };
    // (four small queries, each covered by an index, run in parallel; one $facet had to read every full document)
    const [byStatus, byMembership, expiringSoon, withoutSeat] = await Promise.all([
        Student.aggregate([{ $match: base }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Student.aggregate([{ $match: base }, { $group: { _id: '$planStatus', count: { $sum: 1 } } }]),
        Student.countDocuments({ ...base, expiryDate: { $gte: new Date(), $lte: new Date(Date.now() + 30 * DAY_MS) } }),
        Student.countDocuments({ ...base, seatId: null })
    ]);
    const summary = { total: 0, active: 0, inactive: 0, leave: 0, suspended: 0 };
    byStatus.forEach((g) => { summary[g._id] = g.count; summary.total += g.count; });
    summary.membership = { none: 0, pending: 0, active: 0, paused: 0, expired: 0 };
    byMembership.forEach((g) => { summary.membership[g._id || 'none'] = (summary.membership[g._id || 'none'] || 0) + g.count; });
    summary.expiringSoon = expiringSoon;
    summary.withoutSeat = withoutSeat;

    return { results: students, page, limit, totalPages: Math.ceil(totalResults / limit), totalResults, summary };
};

const getStudentById = async (id, libraryId) => {
    if (!isValidId(id)) throw new ApiError(404, 'Student not found');
    const student = await Student.findOne({ _id: id, libraryId })
        .populate('planId')
        .populate('branchId', 'name');
    if (!student) throw new ApiError(404, 'Student not found');

    const payments = await Payment.find({ studentId: student._id, libraryId })
        .populate('planId', 'name')
        .sort({ createdAt: -1 })
        .limit(3);
    const currentMembership = await MembershipHistory.findOne({ studentId: student._id, libraryId, status: { $in: ['active', 'paused'] } }).sort({ startDate: -1 });

    const obj = student.toObject();
    delete obj.password; delete obj.otp; delete obj.fcmTokens;
    obj.paymentHistory = payments;
    // paymentHistory is only the latest 3 entries, so the total owed is summed across all of them
    const [owed] = await Payment.aggregate([
        { $match: { studentId: student._id, libraryId: student.libraryId } },
        { $group: { _id: null, due: { $sum: '$dueAmount' } } }
    ]);
    obj.feesDue = owed ? owed.due : 0;
    obj.currentMembership = currentMembership;
    return obj;
};

const updateStudentById = async (id, libraryId, body, req) => {
    const student = await loadStudent(id, libraryId);
    if (student.erasedAt) throw new ApiError(400, 'This student record has been erased and cannot be edited');
    const data = pick(body, UPDATE_FIELDS);
    // An emptied optional field clears the stored value (the edit form always sends every field, so skip ones already empty)
    const cleared = CLEARABLE_FIELDS.filter((k) => data[k] === '');
    cleared.forEach((k) => { delete data[k]; });
    const clearing = cleared.filter((k) => student[k] !== undefined && student[k] !== null && student[k] !== '');
    normaliseContactFields(data);
    await applyAadhaar(data, libraryId, { excludeId: student._id });

    // DPDP: consent can be recorded later for older records; guardian consent can be given or withdrawn
    if (dpdp.toBool(body.consentGiven) && !student.consent?.given) data.consent = await buildConsent(req);
    const guardianConsentTouched = body.guardianConsentGiven !== undefined;
    // only a real change is recorded, so re-saving the form keeps the original consent date
    if (guardianConsentTouched && dpdp.toBool(body.guardianConsentGiven) !== !!student.guardianConsent?.given) {
        data.guardianConsent = dpdp.toBool(body.guardianConsentGiven) ? { given: true, givenAt: new Date() } : { given: false };
    }

    // Minors: re-check the guardian block only when the request changes it (or the date of birth), so unrelated edits to an older record are never blocked
    if (data.dob !== undefined || data.guardianName !== undefined || data.guardianMobile !== undefined || guardianConsentTouched || clearing.includes('guardianMobile')) {
        assertMinorRules(clearing.includes('dob') ? null : data.dob !== undefined ? data.dob : student.dob, {
            guardianName: data.guardianName !== undefined ? data.guardianName : student.guardianName,
            guardianMobile: clearing.includes('guardianMobile') ? '' : data.guardianMobile !== undefined ? data.guardianMobile : student.guardianMobile,
            guardianConsentGiven: data.guardianConsent ? data.guardianConsent.given : student.guardianConsent?.given
        });
    }

    if (data.mobile && data.mobile !== student.mobile) {
        const dup = await Student.findOne({ libraryId, mobile: data.mobile, _id: { $ne: student._id } });
        if (dup) throw new ApiError(409, 'A student with this mobile number already exists in this library');
    }
    if (data.branchId !== undefined) data.branchId = data.branchId ? await validateBranch(data.branchId, libraryId) : null;

    Object.assign(student, data);
    clearing.forEach((k) => { student[k] = undefined; });
    try {
        await student.save();
    } catch (e) {
        if (e && e.code === 11000) throw new ApiError(409, 'A student with this mobile number already exists in this library');
        throw e;
    }
    return getStudentById(id, libraryId);
};

/**
 * Archive (soft delete) a student. The seat is released and memberships closed, but
 * payments / ledger entries are left untouched to preserve financial history.
 */
const deleteStudentById = async (id, libraryId, req) => {
    const student = await loadStudent(id, libraryId);

    await seatService.releaseSeatForStudent(student._id, libraryId, { actor: seatService.actorOf(req), reason: 'Student archived' });
    await MembershipHistory.updateMany(
        { studentId: student._id, libraryId, status: { $in: ['active', 'paused'] } },
        { $set: { status: 'cancelled', closedReason: 'student_archived' } }
    );
    const updated = await Student.findOneAndUpdate(
        { _id: student._id, libraryId },
        { $set: { isDeleted: true, deletedAt: new Date(), status: 'inactive', statusReason: 'Archived', seatId: null, seatNumber: null, updatedBy: req?.user?._id } },
        { new: true }
    );
    if (req) audit(req, 'student.archive', 'Student', student._id, { registrationNumber: student.registrationNumber });
    return updated;
};

// ---------------------------------------------------------------------------
// DPDP Act 2023: right to erasure, right to access, storage limitation
// The three functions below read/write through the native collection on purpose: the Student model hides archived
// students from every query, and erasure/retention must work on exactly those records.
// ---------------------------------------------------------------------------
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Delete an uploaded file (path as stored on the student) - only ever inside the uploads / temp upload folders. */
const removeUploadedFile = async (p) => {
    if (!p || typeof p !== 'string') return false;
    const full = path.resolve(path.isAbsolute(p) ? p : path.join(process.cwd(), p));
    const roots = [path.resolve(process.cwd(), 'uploads'), path.resolve(require('os').tmpdir())];
    if (!roots.some((r) => full === r || full.startsWith(r + path.sep))) return false;
    try {
        await fs.promises.unlink(full);
        return true;
    } catch (e) {
        return false;
    }
};

/**
 * Erase a student's personal data (owner-only, reason required). Name, contact details, date of birth, address,
 * Aadhaar, guardian, photo, documents, notes and push tokens are wiped and the files deleted from disk.
 * Payments, receipts and membership history are kept (tax / audit duty) and still point at the anonymised record.
 */
const eraseStudent = async (id, libraryId, { reason } = {}, req) => {
    if (!isValidId(id)) throw new ApiError(404, 'Student not found');
    const why = String(reason || '').trim();
    if (why.length < 3) throw new ApiError(400, 'A reason for the erasure is required');

    const _id = oid(id);
    const lib = oid(libraryId);
    const student = await Student.collection.findOne({ _id, libraryId: lib });
    if (!student) throw new ApiError(404, 'Student not found');
    if (student.erasedAt) throw new ApiError(409, 'This student has already been erased');

    // free the seat and close live memberships (history stays)
    try {
        await seatService.releaseSeatForStudent(_id, lib, { actor: seatService.actorOf(req), reason: 'Student data erased' });
    } catch (e) { /* the seat may already be free */ }
    await MembershipHistory.updateMany({ studentId: _id, libraryId: lib, status: { $in: ['active', 'paused'] } }, { $set: { status: 'cancelled', closedReason: 'student_erased' } });

    const files = [student.profileImage, ...(student.aadhaarCardImage || []), ...(student.documents || []).map((d) => d.url)].filter(Boolean);
    const now = new Date();
    const randomPassword = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);

    await Student.collection.updateOne({ _id, libraryId: lib }, {
        $set: {
            name: 'Erased Student', mobile: `erased-${String(_id)}`, password: randomPassword, mustChangePassword: false,
            status: 'inactive', statusReason: 'Personal data erased', statusChangedAt: now,
            isDeleted: true, deletedAt: student.deletedAt || now, erasedAt: now, erasureReason: why,
            seatId: null, seatNumber: null, tokensValidAfter: now, updatedAt: now,
            fcmTokens: [], documents: [], aadhaarCardImage: [], notes: [], 'consent.given': false, 'guardianConsent.given': false,
            ...(req?.user?._id && { updatedBy: req.user._id })
        },
        $unset: {
            email: '', dob: '', gender: '', address: '', city: '', state: '', country: '', countryCode: '', stateCode: '', pincode: '',
            aadhaarNumber: '', aadhaarLast4: '', aadhaarHash: '', guardianName: '', guardianMobile: '', guardianRelation: '', guardianOccupation: '',
            emergencyContact: '', profileImage: '', rollNumber: '', otp: '', otpExpires: '', leaveUntil: '', 'consent.ip': ''
        }
    });

    // Other records that carry the same personal data
    const Review = require('../models/review.model');
    const Enquiry = require('../models/enquiry.model');
    await Review.updateMany({ studentId: _id, libraryId: lib }, { $set: { studentName: 'Erased Student', isAnonymous: true } }).catch(() => {});
    await Enquiry.updateMany({ convertedStudentId: _id, libraryId: lib }, { $set: { name: 'Erased Student', mobile: 'erased' }, $unset: { email: '', address: '', message: '' } }).catch(() => {});

    let filesRemoved = 0;
    for (const p of files) if (await removeUploadedFile(p)) filesRemoved++;

    if (req) audit(req, 'student.erase', 'Student', _id, { registrationNumber: student.registrationNumber, reason: why, filesRemoved });
    return { id: String(_id), registrationNumber: student.registrationNumber, erasedAt: now, filesRemoved };
};

/** Archived (not yet erased) students whose retention period has passed. Review them, then erase one by one. */
const listRetentionCandidates = async (libraryId, { days } = {}) => {
    const keepDays = Math.min(Math.max(parseInt(days, 10) || dpdp.DEFAULT_RETENTION_DAYS, 1), 3650);
    const cutoff = new Date(Date.now() - keepDays * DAY_MS);
    const rows = await Student.collection.find(
        { libraryId: oid(libraryId), isDeleted: true, erasedAt: { $exists: false }, deletedAt: { $lte: cutoff } },
        { projection: { name: 1, registrationNumber: 1, mobile: 1, deletedAt: 1, branchId: 1 } }
    ).sort({ deletedAt: 1 }).limit(500).toArray();
    return { retentionDays: keepDays, cutoff, count: rows.length, students: rows };
};

/** DPDP right to access: everything we hold about the student, as one JSON document (Aadhaar masked). */
const exportStudentData = async (id, libraryId, req) => {
    if (!isValidId(id)) throw new ApiError(404, 'Student not found');
    const _id = oid(id);
    const lib = oid(libraryId);
    const raw = await Student.collection.findOne({ _id, libraryId: lib });
    if (!raw) throw new ApiError(404, 'Student not found');
    const profile = new Student(raw).toObject();
    delete profile.password;
    const PaymentTransaction = require('../models/paymentTransaction.model');
    const [memberships, charges, transactions] = await Promise.all([
        MembershipHistory.find({ studentId: _id, libraryId: lib }).lean(),
        Payment.find({ studentId: _id, libraryId: lib }).lean(),
        PaymentTransaction.find({ studentId: _id, libraryId: lib }).lean()
    ]);
    if (req) audit(req, 'student.data_export', 'Student', _id, {});
    return {
        exportedAt: new Date(),
        privacyPolicyVersion: await require('./legal.service').privacyVersionLabel(dpdp.PRIVACY_POLICY_VERSION),
        note: 'Aadhaar is held only as its last 4 digits; the full number is not stored.',
        profile, memberships, charges, transactions
    };
};

const getStudentPayments = async (studentId, libraryId) => {
    if (!isValidId(studentId)) throw new ApiError(404, 'Student not found');
    const student = await Student.findOne({ _id: studentId, libraryId }).select('_id');
    if (!student) {
        // archived students keep their payment history
        const archived = await Student.collection.findOne({ _id: new mongoose.Types.ObjectId(String(studentId)), libraryId: new mongoose.Types.ObjectId(String(libraryId)) }, { projection: { _id: 1 } });
        if (!archived) throw new ApiError(404, 'Student not found');
    }
    return Payment.find({ studentId, libraryId }).populate('planId', 'name').sort({ createdAt: -1 });
};

/** Ledger summary: proxies to the fee ledger when available, else aggregates payments. */
const getStudentLedger = async (studentId, libraryId) => {
    if (!isValidId(studentId)) throw new ApiError(404, 'Student not found');
    const student = await Student.findOne({ _id: studentId, libraryId }).select('name registrationNumber');
    if (!student) throw new ApiError(404, 'Student not found');

    const ledger = getLedger();
    if (ledger && typeof ledger.getStudentLedger === 'function') {
        const data = await ledger.getStudentLedger(libraryId, studentId);
        return { source: 'feeLedger', student, ledger: data };
    }

    const [agg] = await Payment.aggregate([
        { $match: { libraryId: new mongoose.Types.ObjectId(String(libraryId)), studentId: new mongoose.Types.ObjectId(String(studentId)) } },
        { $group: { _id: null, totalAmount: { $sum: '$totalAmount' }, paidAmount: { $sum: '$paidAmount' }, dueAmount: { $sum: '$dueAmount' }, count: { $sum: 1 } } }
    ]);
    return {
        source: 'payments',
        student,
        ledger: agg ? { totalAmount: agg.totalAmount, paidAmount: agg.paidAmount, dueAmount: agg.dueAmount, entries: agg.count }
            : { totalAmount: 0, paidAmount: 0, dueAmount: 0, entries: 0 }
    };
};

// CSV of the filtered list (up to 20,000 rows); write(chunk) streams it out
const csvCell = (v) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    if (/^[=+@\t\r-]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const exportStudentsCsv = async (libraryId, q, scope, write) => {
    await write('\uFEFF' + ['Reg. no', 'Name', 'Mobile', 'Email', 'Gender', 'Status', 'Plan', 'Plan status', 'Seat', 'Joined', 'Expires', 'Branch', 'City', 'Guardian', 'Guardian mobile'].map(csvCell).join(',') + '\n');
    const cursor = Student.find(buildStudentFilter(libraryId, q, scope)).select('-notes').populate('planId', 'name').populate('branchId', 'name').sort({ ...(SORTS[q.sort] || SORTS.newest), _id: -1 }).limit(20000).lean().cursor();
    let n = 0;
    for await (const s of cursor) {
        await write([s.registrationNumber, s.name, s.mobile, s.email, s.gender, s.status, s.planId && s.planId.name, s.planStatus, s.seatNumber, s.joiningDate, s.expiryDate, s.branchId && s.branchId.name, s.city, s.guardianName, s.guardianMobile].map(csvCell).join(',') + '\n');
        n++;
    }
    return n;
};

// ---------------------------------------------------------------------------
// Bulk import (spreadsheet rows are parsed in the browser, validated and created here)
// ---------------------------------------------------------------------------
const IMPORT_MAX_ROWS = 100;
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** 10-digit Indian mobile; accepts +91 / 91 / 0 prefixes and spaces or dashes. Returns null when invalid. */
const normaliseMobile = (v) => {
    let d = clean(v).replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return /^[6-9]\d{9}$/.test(d) ? d : null;
};

/** YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY or DD.MM.YYYY. Returns a Date, null when blank, undefined when unreadable. */
const parseImportDate = (v) => {
    const t = clean(v);
    if (!t) return null;
    let y; let m; let d;
    let x = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
    if (x) {
        [, y, m, d] = x;
    } else {
        x = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
        if (!x) return undefined;
        [, d, m, y] = x;
    }
    const date = new Date(Date.UTC(+y, +m - 1, +d, 6, 30)); // noon IST, so the calendar day never shifts
    return date.getUTCFullYear() === +y && date.getUTCMonth() === +m - 1 && date.getUTCDate() === +d ? date : undefined;
};

const GENDERS = { male: 'Male', m: 'Male', female: 'Female', f: 'Female', other: 'Other', o: 'Other' };

/**
 * Create many students from parsed spreadsheet rows. Each row succeeds or fails on its own, so one bad
 * row never blocks the rest. The mobile number is the unique key: a number already in this library is
 * reported as a duplicate and skipped. With dryRun nothing is written.
 */
const importStudents = async (libraryId, rows, req, { dryRun = false, branchId = null, consentConfirmed = false } = {}) => {
    // DPDP: nobody is imported without the importer confirming consent was collected (guardian consent for under-18s)
    if (!dryRun && !consentConfirmed) throw new ApiError(400, "Confirm that each student's consent (and a guardian's consent for students under 18) has been collected before importing");
    const [plans, seats] = await Promise.all([
        Plan.find({ libraryId, isDeleted: { $ne: true } }).select('name').lean(),
        Seat.find({ libraryId, isDeleted: { $ne: true }, status: 'available' }).select('seatNumber').lean()
    ]);
    const planByName = new Map(plans.map((p) => [String(p.name).trim().toLowerCase(), p]));
    const seatByNumber = new Map(seats.map((s) => [String(s.seatNumber).trim().toLowerCase(), s]));

    const parsed = rows.map((raw, i) => {
        const row = { rowNumber: Number(raw.rowNumber) || i + 1, errors: [] };
        const name = clean(raw.name);
        if (name.length < 2) row.errors.push('Name is required (min 2 characters)');
        const mobile = normaliseMobile(raw.mobile);
        if (!mobile) row.errors.push('Mobile must be a valid 10-digit number');
        const email = clean(raw.email).toLowerCase();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) row.errors.push('Invalid email address');
        const g = clean(raw.gender);
        const gender = g ? GENDERS[g.toLowerCase()] : undefined;
        if (g && !gender) row.errors.push('Gender must be Male, Female or Other');
        const dob = parseImportDate(raw.dob);
        if (dob === undefined) row.errors.push('Date of birth must look like DD/MM/YYYY');
        const joiningDate = parseImportDate(raw.joiningDate);
        if (joiningDate === undefined) row.errors.push('Joining date must look like DD/MM/YYYY');
        const guardianMobile = clean(raw.guardianMobile) ? normaliseMobile(raw.guardianMobile) : '';
        if (guardianMobile === null) row.errors.push('Guardian mobile must be a valid 10-digit number');
        const aadhaarText = clean(raw.aadhaarNumber).replace(/[\s-]/g, '');
        if (aadhaarText && !isValidAadhaar(aadhaarText)) row.errors.push('Aadhaar number is not valid (12 digits, starting 2-9, correct check digit)');
        const pincodeText = clean(raw.pincode);
        if (pincodeText && !INDIAN_PINCODE.test(pincodeText)) row.errors.push('Pincode must be 6 digits');
        if (dob && dpdp.isMinor(dob) && (!clean(raw.guardianName) || !guardianMobile)) {
            row.errors.push('Guardian name and a valid guardian mobile are required for a student under 18');
        }

        const planText = clean(raw.plan);
        const plan = planText ? planByName.get(planText.toLowerCase()) : null;
        if (planText && !plan) row.errors.push(`Plan "${planText}" was not found`);
        const seatText = clean(raw.seatNumber);
        const seat = seatText ? seatByNumber.get(seatText.toLowerCase()) : null;
        if (seatText && !seat) row.errors.push(`Seat "${seatText}" was not found or is not available`);

        row.name = name;
        row.mobile = mobile || clean(raw.mobile);
        row.data = {
            name, mobile,
            ...(email && { email }), ...(gender && { gender }), ...(dob && { dob }), ...(joiningDate && { joiningDate }),
            ...(clean(raw.rollNumber) && { rollNumber: clean(raw.rollNumber) }),
            ...(aadhaarText && { aadhaarNumber: aadhaarText }),
            consentGiven: true, guardianConsentGiven: true, // confirmed once for the whole file (checked above)
            ...(clean(raw.guardianName) && { guardianName: clean(raw.guardianName) }),
            ...(guardianMobile && { guardianMobile }),
            ...(clean(raw.address) && { address: clean(raw.address) }),
            ...(clean(raw.city) && { city: clean(raw.city) }),
            ...(clean(raw.state) && { state: clean(raw.state) }),
            ...(clean(raw.pincode) && { pincode: clean(raw.pincode) }),
            ...(branchId && { branchId }),
            ...(plan && { planId: plan._id }),
            ...(seat && { seatId: seat._id })
        };
        return row;
    });

    // Duplicates inside the file (first occurrence wins) and against students already in the library
    const seenMobile = new Map();
    const seenSeat = new Set();
    parsed.forEach((r) => {
        if (r.data.mobile) {
            if (seenMobile.has(r.data.mobile)) r.errors.push(`Duplicate mobile in the file (also on row ${seenMobile.get(r.data.mobile)})`);
            else seenMobile.set(r.data.mobile, r.rowNumber);
        }
        if (r.data.seatId) {
            const k = String(r.data.seatId);
            if (seenSeat.has(k)) r.errors.push('Same seat used twice in the file');
            seenSeat.add(k);
        }
    });
    const existing = new Set((await Student.find({ libraryId, mobile: { $in: [...seenMobile.keys()] } }).select('mobile').lean()).map((s) => s.mobile));

    const results = [];
    for (let i = 0; i < parsed.length; i++) {
        const r = parsed[i];
        const base = { row: r.rowNumber, name: r.name, mobile: r.mobile };
        if (r.data.mobile && existing.has(r.data.mobile)) {
            results.push({ ...base, status: 'duplicate', message: 'A student with this mobile already exists' });
            continue;
        }
        if (r.errors.length) {
            results.push({ ...base, status: 'failed', message: r.errors.join('; ') });
            continue;
        }
        if (dryRun) {
            results.push({ ...base, status: 'valid' });
            continue;
        }
        try {
            const out = await registerStudent(libraryId, r.data, req);
            results.push({ ...base, status: 'created', registrationNumber: out.student.registrationNumber, tempPassword: out.credentials && out.credentials.tempPassword, message: out.warnings.join('; ') || undefined });
        } catch (e) {
            results.push({ ...base, status: e.statusCode === 409 ? 'duplicate' : 'failed', message: e.message });
            if (e.statusCode === 403) { // subscription limit: every remaining row would fail the same way
                parsed.slice(i + 1).forEach((x) => results.push({ row: x.rowNumber, name: x.name, mobile: x.mobile, status: 'failed', message: e.message }));
                break;
            }
        }
    }

    const count = (s) => results.filter((x) => x.status === s).length;
    const summary = { total: results.length, created: count('created'), valid: count('valid'), duplicate: count('duplicate'), failed: count('failed') };
    if (!dryRun && req && summary.created) audit(req, 'student.import', 'Student', null, { created: summary.created, duplicate: summary.duplicate, failed: summary.failed });
    return { dryRun, summary, results };
};

module.exports = {
    importStudents,
    IMPORT_MAX_ROWS,
    activateMembership,
    registerStudent,
    assignPlan,
    markAsPaid,
    changePlan,
    renewMembership,
    pauseMembership,
    resumeMembership,
    extendMembership,
    getMemberships,
    setStatus,
    addNote,
    getNotes,
    resetPassword,
    changeStudentPassword,
    queryStudents,
    getStudentById,
    updateStudentById,
    deleteStudentById,
    eraseStudent,
    listRetentionCandidates,
    exportStudentData,
    getStudentPayments,
    getStudentLedger,
    exportStudentsCsv,
    getPolicy,
    generateTempPassword
};

// ---- Live dashboards: tell connected dashboards that student data changed (no-op without sockets, never throws) ----
const realtime = require('../realtime/emitters');
const branchOf = (r) => (r && (r.branchId || (r.student && r.student.branchId))) || null;
const changed = (kind) => ([, libraryId], r) => realtime.studentChanged({ libraryId, branchId: branchOf(r), kind });
module.exports.registerStudent = realtime.after(registerStudent, ([libraryId], r) => realtime.studentCreated({ libraryId, branchId: branchOf(r) }));
module.exports.importStudents = realtime.after(importStudents, ([libraryId, , , opts], r) => { if (!(opts && opts.dryRun)) realtime.studentChanged({ libraryId, kind: 'import' }); });
module.exports.deleteStudentById = realtime.after(deleteStudentById, changed('deleted'));
for (const name of ['assignPlan', 'markAsPaid', 'changePlan', 'renewMembership', 'pauseMembership', 'resumeMembership', 'extendMembership', 'setStatus', 'updateStudentById']) {
    module.exports[name] = realtime.after(module.exports[name], changed(name === 'setStatus' ? 'status' : name === 'updateStudentById' ? 'updated' : 'plan'));
}
