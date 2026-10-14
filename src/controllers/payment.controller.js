const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const Student = require('../models/student.model');
const Payment = require('../models/payment.model');
const { tenantId } = require('../middlewares/access.middleware');
const ledger = require('../services/feeLedger.service');
const { branchFilter, assertBranchAccess, isValidId } = require('../utils/branchScope');

// Branch-limited staff may only touch charges / students of their own branches
const guardPayment = async (req, paymentId) => {
    if (req.userType !== 'staff' || !isValidId(paymentId)) return;
    const p = await Payment.findOne({ _id: paymentId, libraryId: req.libraryId }).select('branchId').lean();
    if (p) assertBranchAccess(req, p.branchId);
};
const guardStudent = async (req, studentId) => {
    if (req.userType !== 'staff' || !isValidId(studentId)) return;
    const s = await Student.findOne({ _id: studentId, libraryId: req.libraryId }).select('branchId').lean();
    if (s) assertBranchAccess(req, s.branchId);
};

const lib = (req) => {
    const id = tenantId(req);
    if (!id) throw new ApiError(400, 'Library context is required');
    return id;
};

const ok = (res, message, data, extra = {}, code = 200) =>
    res.status(code).json({ success: true, message, data, ...extra });

// POST /payments : create a charge and/or collect money (staff only)
const createPayment = catchAsync(async (req, res) => {
    const libraryId = lib(req);
    const b = req.body;
    await guardStudent(req, b.studentId);
    const chargeAmount = b.amount !== undefined ? b.amount : b.totalAmount;
    const hasCharge = !!(b.planId || chargeAmount !== undefined);
    const paid = Number(b.paidAmount) || 0;

    let charge = null;
    if (hasCharge) {
        charge = await ledger.createCharge({
            libraryId, studentId: b.studentId, planId: b.planId, amount: chargeAmount,
            dueDate: b.dueDate, description: b.description, createdBy: req.user._id,
            couponCode: b.couponCode, joiningFee: b.joiningFee, deposit: b.deposit,
            referrerId: b.referrerId, remarks: b.remarks, paidNow: paid, req
        });
    }

    let receipt = null;
    if (paid > 0) {
        try {
            receipt = await ledger.recordPayment({
                libraryId, studentId: b.studentId, amount: paid, method: b.paymentMethod,
                reference: b.reference, receivedBy: req.user._id, paymentDate: b.paymentDate,
                note: b.note || b.remarks,
                allocations: charge ? [{ paymentId: charge._id, amount: paid }] : b.allocations,
                trustedAllocation: !!charge, req
            });
        } catch (e) {
            if (charge) await ledger.rollbackCharge(libraryId, charge._id, `Collection failed: ${e.message}`);
            throw e;
        }
    }

    const fresh = charge ? await ledger.getPaymentById(libraryId, charge._id) : null;
    ok(res, receipt ? 'Payment recorded successfully' : 'Charge created successfully', fresh || (receipt && receipt.transaction), {
        receipt: receipt ? { receiptNo: receipt.receiptNumber, transactionId: receipt.transaction._id, outstandingAfter: receipt.outstandingAfter } : undefined
    }, 201);
});

// PATCH /payments/:paymentId/collect
const collectPartialPayment = catchAsync(async (req, res) => {
    const libraryId = lib(req);
    await guardPayment(req, req.params.paymentId);
    const charge = await Payment.findOne({ _id: req.params.paymentId, libraryId });
    if (!charge) {
        await require('../utils/securityEvent').flagIfOtherTenant(req, Payment, req.params.paymentId, 'Payment');
        throw new ApiError(404, 'Payment not found');
    }
    const amount = req.body.amount || req.body.additionalAmount;
    const receipt = await ledger.recordPayment({
        libraryId, studentId: charge.studentId, amount, method: req.body.paymentMethod,
        reference: req.body.reference, receivedBy: req.user._id, paymentDate: req.body.paymentDate,
        note: req.body.note || req.body.remarks,
        allocations: [{ paymentId: charge._id, amount }], trustedAllocation: true, req
    });
    const fresh = await ledger.getPaymentById(libraryId, charge._id);
    ok(res, 'Payment collected successfully', fresh, {
        receipt: { receiptNo: receipt.receiptNumber, transactionId: receipt.transaction._id, outstandingAfter: receipt.outstandingAfter }
    });
});

const getPayments = catchAsync(async (req, res) => {
    const result = await ledger.queryPayments(lib(req), req.query, branchFilter(req));
    res.status(200).json({ success: true, message: 'Payments retrieved successfully', ...result });
});

const getPayment = catchAsync(async (req, res) => {
    await guardPayment(req, req.params.paymentId);
    const payment = await require('../utils/securityEvent').flagOnMiss(req, Payment, req.params.paymentId, 'Payment',
        () => ledger.getPaymentById(lib(req), req.params.paymentId));
    ok(res, 'Payment retrieved successfully', payment);
});

const refundPayment = catchAsync(async (req, res) => {
    await guardPayment(req, req.params.paymentId);
    const txn = await ledger.refundPayment({
        libraryId: lib(req), paymentId: req.params.paymentId, transactionId: req.body.transactionId,
        amount: req.body.amount, reason: req.body.reason, method: req.body.method, req,
        requestId: req.body.requestId || req.get('Idempotency-Key'), refundToGateway: req.body.refundToGateway
    });
    const fresh = await ledger.getPaymentById(lib(req), req.params.paymentId);
    ok(res, txn.$locals && txn.$locals.replay ? 'Refund already recorded' : 'Refund recorded successfully', fresh, {
        refund: { transactionId: txn._id, reference: txn.receiptNumber, amount: txn.amount, razorpayRefundId: txn.razorpayRefundId, gateway: txn.refundToGateway === true, replay: !!(txn.$locals && txn.$locals.replay) }
    });
});

const adjustPayment = catchAsync(async (req, res) => {
    await guardPayment(req, req.params.paymentId);
    const charge = await ledger.adjustCharge({ ...req.body, libraryId: lib(req), paymentId: req.params.paymentId, req });
    ok(res, 'Payment adjusted successfully', charge);
});

const cancelPayment = catchAsync(async (req, res) => {
    await guardPayment(req, req.params.paymentId);
    const charge = await ledger.cancelCharge({ libraryId: lib(req), paymentId: req.params.paymentId, reason: req.body.reason, req });
    ok(res, 'Payment cancelled successfully', charge);
});

const getReceipt = catchAsync(async (req, res) => {
    await guardPayment(req, req.params.paymentId);
    const receipt = await ledger.buildReceipt({ libraryId: lib(req), id: req.params.paymentId });
    ok(res, 'Receipt retrieved successfully', receipt);
});

const getOutstanding = catchAsync(async (req, res) => {
    const r = await ledger.getLibraryOutstanding(lib(req), {
        page: Math.max(1, parseInt(req.query.page, 10) || 1),
        limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20)),
        search: req.query.search,
        scope: branchFilter(req)
    });
    res.status(200).json({ success: true, message: 'Outstanding dues retrieved successfully', ...r });
});

const getOverdue = catchAsync(async (req, res) => {
    const r = await ledger.getLibraryOutstanding(lib(req), {
        overdueOnly: true,
        page: Math.max(1, parseInt(req.query.page, 10) || 1),
        limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20)),
        search: req.query.search,
        scope: branchFilter(req)
    });
    res.status(200).json({ success: true, message: 'Overdue dues retrieved successfully', ...r });
});

const getStudentLedger = catchAsync(async (req, res) => {
    await guardStudent(req, req.params.studentId);
    const data = await ledger.getStudentLedger(lib(req), req.params.studentId);
    ok(res, 'Student ledger retrieved successfully', data);
});

// ── student-facing, own data only ─────────────────────────────────────────────
const getMyLedger = catchAsync(async (req, res) => {
    const data = await ledger.getStudentLedger(req.libraryId, req.user._id);
    ok(res, 'Your fee ledger', data);
});

const getMyReceipt = catchAsync(async (req, res) => {
    const receipt = await ledger.buildReceipt({ libraryId: req.libraryId, id: req.params.paymentId, studentId: req.user._id });
    ok(res, 'Receipt retrieved successfully', receipt);
});

module.exports = {
    createPayment, collectPartialPayment, getPayments, getPayment, refundPayment, adjustPayment,
    cancelPayment, getReceipt, getOutstanding, getOverdue, getStudentLedger, getMyLedger, getMyReceipt
};
