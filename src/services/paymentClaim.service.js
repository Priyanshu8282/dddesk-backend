const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const PaymentClaim = require('../models/paymentClaim.model');
const Student = require('../models/student.model');
const Library = require('../models/library.model');
const Payment = require('../models/payment.model');
const ledger = require('./feeLedger.service');
const { notifyEvent } = require('./notification.service');
const { branchFilter, assertBranchAccess, isValidId } = require('../utils/branchScope');

// Student scans the owner's own UPI QR, pays in their own UPI app (no gateway, no webhook), then tells
// DDdesk what they paid. Nothing in the real ledger changes until an owner/staff member approves this -
// see approve() below, which is the only place money actually gets recorded.

/** Student: the library's QR image + name, for the "scan and pay" screen. */
exports.getPaymentQr = async (studentId) => {
    const student = await Student.findById(studentId).select('libraryId').lean();
    if (!student) throw new ApiError(404, 'Student not found');
    const library = await Library.findById(student.libraryId).select('name paymentQr').lean();
    if (!library) throw new ApiError(404, 'Library not found');
    return { libraryName: library.name, paymentQrPath: library.paymentQr || null };
};

/** Student: submit a claim after paying the QR outside the app. */
exports.submitClaim = async (studentId, body) => {
    const student = await Student.findById(studentId);
    if (!student) throw new ApiError(404, 'Student not found');

    let paymentId = null;
    if (body.paymentId) {
        if (!isValidId(body.paymentId)) throw new ApiError(400, 'Invalid paymentId');
        const charge = await Payment.findOne({ _id: body.paymentId, libraryId: student.libraryId, studentId: student._id }).select('_id').lean();
        if (!charge) throw new ApiError(400, 'That due does not belong to you');
        paymentId = charge._id;
    }

    const claim = await PaymentClaim.create({
        libraryId: student.libraryId,
        studentId: student._id,
        branchId: student.branchId || null,
        paymentId,
        amount: body.amount,
        transactionId: body.transactionId,
        note: body.note,
    });

    notifyEvent('payment-claim-submitted', student.libraryId, {
        toAdmins: true,
        variables: { studentName: student.name, amount: claim.amount, transactionId: claim.transactionId },
        data: { claimId: String(claim._id), screen: 'payments' }
    }).catch(() => {});

    return claim;
};

/** Student: their own claim history, so a pending/rejected claim is visible before (or without) approval. */
exports.listMyClaims = async (studentId, query = {}) => {
    const filter = { studentId };
    if (query.status) filter.status = query.status;
    const page = query.page || 1;
    const limit = query.limit || 20;

    const [rows, total] = await Promise.all([
        PaymentClaim.find(filter).sort({ submittedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        PaymentClaim.countDocuments(filter),
    ]);
    return { claims: rows, total, page, limit };
};

/** Owner/staff: list claims for their library (branch-scoped for branch staff), pending first by default. */
exports.listClaims = async (req, libraryId, query = {}) => {
    const filter = { libraryId, ...branchFilter(req) };
    if (query.status) filter.status = query.status;
    const page = query.page || 1;
    const limit = query.limit || 20;
    const sort = filter.status === 'pending' || !query.status ? { status: 1, submittedAt: -1 } : { submittedAt: -1 };

    const [rows, total] = await Promise.all([
        PaymentClaim.find(filter)
            .populate('studentId', 'name mobile seatNumber')
            .populate('reviewedBy', 'name')
            .sort(sort).skip((page - 1) * limit).limit(limit).lean(),
        PaymentClaim.countDocuments(filter),
    ]);
    return { claims: rows, total, page, limit };
};

const loadForReview = async (req, libraryId, claimId) => {
    if (!isValidId(claimId)) throw new ApiError(400, 'Invalid claim id');
    const claim = await PaymentClaim.findOne({ _id: claimId, libraryId });
    if (!claim) throw new ApiError(404, 'Payment claim not found');
    assertBranchAccess(req, claim.branchId);
    return claim;
};

/**
 * Owner/staff approves a claim: this is the ONLY place a claim turns into a real payment. Reuses the exact
 * same feeLedger.service.recordPayment() that every other "collect payment" action in the app goes through,
 * with method 'upi' and the student's transaction id as the reference, so it produces a normal receipt and
 * updates dues exactly like a manually-recorded UPI payment would.
 */
exports.approveClaim = async (req, libraryId, claimId, body = {}) => {
    const claim = await loadForReview(req, libraryId, claimId);
    if (claim.status !== 'pending') {
        if (claim.status === 'approved') return claim; // already done - idempotent re-click
        throw new ApiError(400, `This claim was already ${claim.status}`);
    }

    const student = await Student.findOne({ _id: claim.studentId, libraryId }).select('name').lean();
    if (!student) throw new ApiError(404, 'Student not found');

    let receipt;
    try {
        receipt = await ledger.recordPayment({
            libraryId, studentId: claim.studentId, amount: claim.amount, method: 'upi',
            reference: claim.transactionId, receivedBy: req.user._id,
            note: `UPI QR payment claim${claim.note ? `: ${claim.note}` : ''}`,
            allocations: claim.paymentId ? [{ paymentId: claim.paymentId, amount: claim.amount }] : undefined,
            collectRequestId: `payment-claim:${claim._id}`, req
        });
    } catch (e) {
        throw new ApiError(400, `Could not record this payment: ${e.message}`);
    }

    claim.status = 'approved';
    claim.reviewedBy = req.user._id;
    claim.reviewedAt = new Date();
    claim.resultTransactionId = receipt.transaction._id;
    claim.resultReceiptNumber = receipt.receiptNumber;
    await claim.save();

    notifyEvent('payment-claim-approved', libraryId, {
        studentId: claim.studentId,
        variables: { studentName: student.name, amount: claim.amount, receiptNo: receipt.receiptNumber },
        data: { claimId: String(claim._id), screen: 'fees' }
    }).catch(() => {});

    return claim;
};

exports.rejectClaim = async (req, libraryId, claimId, reason) => {
    const claim = await loadForReview(req, libraryId, claimId);
    if (claim.status !== 'pending') throw new ApiError(400, `This claim was already ${claim.status}`);

    const student = await Student.findOne({ _id: claim.studentId, libraryId }).select('name').lean();

    claim.status = 'rejected';
    claim.reviewedBy = req.user._id;
    claim.reviewedAt = new Date();
    claim.rejectReason = reason;
    await claim.save();

    notifyEvent('payment-claim-rejected', libraryId, {
        studentId: claim.studentId,
        variables: { studentName: student?.name || '', amount: claim.amount, reasonSuffix: reason ? ` Reason: ${reason}.` : '' },
        data: { claimId: String(claim._id), screen: 'fees' }
    }).catch(() => {});

    return claim;
};
