const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const Student = require('../models/student.model');
const Payment = require('../models/payment.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const { tenantId } = require('../middlewares/access.middleware');
const ledger = require('../services/feeLedger.service');
const { branchFilter, assertBranchAccess, isValidId } = require('../utils/branchScope');

// Branch-limited staff may only touch charges / students of their own branches
const guardPayment = async (req, paymentId) => {
    if (req.userType !== 'staff' || !isValidId(paymentId)) return;
    const p = await Payment.findOne({ _id: paymentId, libraryId: req.libraryId }).select('branchId').lean();
    if (p) assertBranchAccess(req, p.branchId);
};
// A receipt id may be a charge (Payment) id or a receipt/refund (PaymentTransaction) id: check both
const guardReceipt = async (req, id) => {
    if (req.userType !== 'staff' || !isValidId(id)) return;
    await guardPayment(req, id);
    const t = await PaymentTransaction.findOne({ _id: id, libraryId: req.libraryId }).select('branchId studentId').lean();
    if (!t) return;
    if (t.branchId) assertBranchAccess(req, t.branchId);
    else await guardStudent(req, t.studentId);
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

    // Idempotency: a retry / double click with the same key returns the original receipt, never a second charge
    const requestId = b.requestId || req.get('Idempotency-Key') || undefined;
    if (requestId && paid > 0) {
        const replay = await ledger.replayCollection(libraryId, requestId, { studentId: b.studentId, amount: paid });
        if (replay) {
            const chargeId = replay.allocations && replay.allocations[0] && replay.allocations[0].paymentId;
            const original = chargeId ? await ledger.getPaymentById(libraryId, chargeId) : null;
            return ok(res, 'Payment already recorded', original || replay.transaction, {
                receipt: { receiptNo: replay.receiptNumber, transactionId: replay.transaction._id, outstandingAfter: replay.outstandingAfter },
                replay: true
            }, 200);
        }
    }

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
                trustedAllocation: !!charge, collectRequestId: requestId, req
            });
        } catch (e) {
            if (charge) await ledger.rollbackCharge(libraryId, charge._id, `Collection failed: ${e.message}`);
            throw e;
        }
    }

    const fresh = charge ? await ledger.getPaymentById(libraryId, charge._id) : null;
    ok(res, receipt ? (receipt.replay ? 'Payment already recorded' : 'Payment recorded successfully') : 'Charge created successfully', fresh || (receipt && receipt.transaction), {
        receipt: receipt ? { receiptNo: receipt.receiptNumber, transactionId: receipt.transaction._id, outstandingAfter: receipt.outstandingAfter } : undefined,
        replay: receipt ? !!receipt.replay : undefined
    }, receipt && receipt.replay ? 200 : 201);
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
        allocations: [{ paymentId: charge._id, amount }], trustedAllocation: true,
        collectRequestId: req.body.requestId || req.get('Idempotency-Key') || undefined, req
    });
    const fresh = await ledger.getPaymentById(libraryId, charge._id);
    ok(res, receipt.replay ? 'Payment already recorded' : 'Payment collected successfully', fresh, {
        receipt: { receiptNo: receipt.receiptNumber, transactionId: receipt.transaction._id, outstandingAfter: receipt.outstandingAfter },
        replay: !!receipt.replay
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
    if (!(txn.$locals && txn.$locals.replay)) {
        require('../utils/securityLog').record(req, { type: 'refund', outcome: 'success', userId: req.user?._id || null, userType: req.userType || null, libraryId: req.libraryId || null, identifier: req.user?.email || null, meta: { paymentId: String(req.params.paymentId), amount: txn.amount, gateway: txn.refundToGateway === true } });
    }
    const fresh = await ledger.getPaymentById(lib(req), req.params.paymentId);
    const warning = await ledger.membershipWarning(lib(req), fresh);
    ok(res, txn.$locals && txn.$locals.replay ? 'Refund already recorded' : 'Refund recorded successfully', fresh, {
        warning: warning || undefined,
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
    const warning = await ledger.membershipWarning(lib(req), charge);
    ok(res, 'Payment cancelled successfully', charge, { warning: warning || undefined });
});

const getReceipt = catchAsync(async (req, res) => {
    await guardReceipt(req, req.params.paymentId);
    const receipt = await ledger.buildReceipt({ libraryId: lib(req), id: req.params.paymentId });
    ok(res, 'Receipt retrieved successfully', receipt);
});

const getSummary = catchAsync(async (req, res) => {
    const data = await ledger.getPaymentsSummary(lib(req), branchFilter(req));
    ok(res, 'Payments summary retrieved successfully', data);
});

const exportPayments = catchAsync(async (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payments-${new Date().toISOString().slice(0, 10)}.csv"`);
    await ledger.exportPaymentsCsv(lib(req), req.query, branchFilter(req), (chunk) => new Promise((resolve) => (res.write(chunk) ? resolve() : res.once('drain', resolve))));
    res.end();
});

const getOutstanding = catchAsync(async (req, res) => {
    const r = await ledger.getLibraryOutstanding(lib(req), {
        sort: req.query.sort,
        page: Math.max(1, parseInt(req.query.page, 10) || 1),
        limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20)),
        search: req.query.search,
        scope: branchFilter(req)
    });
    res.status(200).json({ success: true, message: 'Outstanding dues retrieved successfully', ...r });
});

const getOverdue = catchAsync(async (req, res) => {
    const r = await ledger.getLibraryOutstanding(lib(req), {
        sort: req.query.sort,
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
    cancelPayment, getReceipt, getSummary, exportPayments, getOutstanding, getOverdue, getStudentLedger, getMyLedger, getMyReceipt
};
