const crypto = require('crypto');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const PaymentTransaction = require('../models/paymentTransaction.model');
const WebhookEvent = require('../models/webhookEvent.model');
const ledger = require('../services/feeLedger.service');

const client = () => require('../services/razorpayClient').getClient();

const hmac = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

// Constant-time string compare
const safeEqual = (a, b) => {
    const A = Buffer.from(String(a || ''), 'utf8');
    const B = Buffer.from(String(b || ''), 'utf8');
    if (A.length !== B.length || A.length === 0) return false;
    return crypto.timingSafeEqual(A, B);
};

// Who is paying and for which student. Students pay only for themselves.
const resolveStudentId = (req) => {
    if (req.userType === 'student') return req.user._id;
    if (!req.body.studentId) throw new ApiError(400, 'studentId is required');
    return req.body.studentId;
};

// ─────────────────────────────────────────────────────────────
// POST /payments/razorpay/create-order
// Amount is always derived from the student's DB dues; the client can only
// ask for a smaller (partial) amount, never a larger/arbitrary one.
// ─────────────────────────────────────────────────────────────
const createOrder = catchAsync(async (req, res) => {
    const libraryId = req.libraryId;
    if (!libraryId) throw new ApiError(400, 'Library context is required');
    const studentId = resolveStudentId(req);
    const chargeIds = req.body.chargeIds || (req.body.paymentId ? [req.body.paymentId] : undefined);

    const rz = client();
    const { attempt, payable } = await ledger.createOnlineAttempt({
        libraryId, studentId, chargeIds, amount: req.body.amount,
        createdBy: req.user._id, createdByType: req.userType === 'student' ? 'student' : req.userType
    });

    let order;
    try {
        order = await rz.orders.create({
            amount: Math.round(attempt.amount * 100),
            currency: 'INR',
            receipt: `att_${attempt._id}`,
            notes: { attemptId: String(attempt._id), studentId: String(studentId), libraryId: String(libraryId) }
        });
    } catch (e) {
        await ledger.failAttempt(attempt, `Order creation failed: ${(e && e.message) || 'gateway error'}`);
        throw new ApiError(502, 'Could not create the payment order. Please try again');
    }
    attempt.razorpayOrderId = order.id;
    await attempt.save();

    res.status(200).json({
        success: true,
        message: 'Razorpay order created successfully',
        data: {
            orderId: order.id,
            attemptId: attempt._id,
            amount: order.amount, // paise
            amountInr: attempt.amount,
            currency: 'INR',
            key: process.env.RAZORPAY_KEY_ID,
            payable,
            allocations: attempt.allocations
        }
    });
});

// ─────────────────────────────────────────────────────────────
// POST /payments/razorpay/verify(-payment)
// ─────────────────────────────────────────────────────────────
const alreadyDone = (res, t) => res.status(200).json({
    success: true,
    message: 'Payment already verified',
    alreadyProcessed: true,
    data: { transactionId: t._id, receiptNo: t.receiptNumber, amount: t.amount }
});

const verifyPayment = catchAsync(async (req, res) => {
    const orderId = req.body.razorpayOrderId || req.body.razorpay_order_id;
    const paymentId = req.body.razorpayPaymentId || req.body.razorpay_payment_id;
    const signature = req.body.razorpaySignature || req.body.razorpay_signature;
    if (!orderId || !paymentId || !signature) throw new ApiError(400, 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required');
    if (!process.env.RAZORPAY_KEY_SECRET) throw new ApiError(503, 'Online payments are not configured'); // fail closed

    const scope = { razorpayOrderId: String(orderId), libraryId: req.libraryId };
    if (req.userType === 'student') scope.studentId = req.user._id;
    const existing = await PaymentTransaction.findOne(scope);
    if (!existing) throw new ApiError(404, 'Payment order not found');

    // Idempotent replay: already settled -> do nothing
    if (existing.status === 'success') {
        if (existing.razorpayPaymentId && existing.razorpayPaymentId !== paymentId) throw new ApiError(409, 'Order already paid with a different payment');
        return alreadyDone(res, existing);
    }

    const expected = hmac(process.env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);
    if (!safeEqual(expected, signature)) {
        await ledger.failAttempt(existing, 'Invalid payment signature');
        throw new ApiError(400, 'Payment verification failed - invalid signature');
    }

    const attempt = await ledger.claimAttempt({ _id: existing._id });
    if (!attempt) {
        const again = await PaymentTransaction.findById(existing._id);
        if (again && again.status === 'success') return alreadyDone(res, again);
        throw new ApiError(409, again && again.needsReview
            ? 'This payment needs manual review by the library'
            : 'Payment is already being processed');
    }

    const result = await ledger.finalizeOnlineAttempt(attempt, { razorpayPaymentId: paymentId, razorpaySignature: signature, source: 'verify' });
    res.status(200).json({
        success: true,
        message: 'Payment verified successfully',
        data: {
            transactionId: result.transaction._id,
            receiptNo: result.receiptNumber,
            amount: result.transaction.amount,
            outstandingAfter: result.outstandingAfter
        }
    });
});

// ─────────────────────────────────────────────────────────────
// Webhook event handling
// ─────────────────────────────────────────────────────────────
const handleEvent = async (event) => {
    const pay = event.payload && event.payload.payment && event.payload.payment.entity;
    if (event.event === 'payment.captured' || event.event === 'order.paid') {
        if (!pay || !pay.order_id) return;
        const attempt0 = await PaymentTransaction.findOne({ razorpayOrderId: pay.order_id });
        if (!attempt0) {
            const sub = require('../services/subscription.service');
            await sub.handleCaptured(pay);
            return;
        }
        if (attempt0.status === 'success') return;
        if (pay.amount !== Math.round(attempt0.amount * 100) || (pay.currency && pay.currency !== 'INR')) {
            await ledger.failAttempt(attempt0, 'Captured amount does not match the order', { needsReview: true, razorpayPaymentId: pay.id });
            return;
        }
        const attempt = await ledger.claimAttempt({ _id: attempt0._id });
        if (!attempt) {
            const again = await PaymentTransaction.findById(attempt0._id);
            if (again && again.status === 'success') return;
            if (again && again.status === 'failed' && again.needsReview) return;
            throw new ApiError(409, 'Attempt is being processed'); // Razorpay retries later
        }
        await ledger.finalizeOnlineAttempt(attempt, { razorpayPaymentId: pay.id, source: 'webhook' });
        return;
    }
    if (event.event === 'payment.failed') {
        if (!pay || !pay.order_id) return;
        const attempt = await PaymentTransaction.findOne({ razorpayOrderId: pay.order_id });
        if (!attempt) {
            const sub = require('../services/subscription.service');
            await sub.handleFailed(pay);
            return;
        }
        await ledger.failAttempt(attempt, pay.error_description || 'Payment failed at gateway');
        return;
    }
    if (event.event === 'refund.processed') {
        const rf = event.payload && event.payload.refund && event.payload.refund.entity;
        if (!rf || !rf.payment_id) return;
        // Already recorded by our own refund flow (matched on gateway refund id) -> idempotent no-op
        const known = await PaymentTransaction.findOne({ razorpayRefundId: rf.id, type: 'refund' });
        if (known) {
            if (known.status === 'failed' && known.needsReview) {
                // gateway refunded but our ledger update failed earlier: finish it now
                await ledger.refundPayment({
                    libraryId: known.libraryId, transactionId: known.refundOf, amount: known.amount, reason: known.reason || 'Refund processed by payment gateway',
                    method: 'online', requestId: known.refundRequestId, razorpayRefundId: rf.id, razorpayPaymentId: rf.payment_id
                });
            }
            return;
        }
        // Refund created by our API but its gateway id is not stored yet (webhook raced the API response): match by request id
        const rid = rf.notes && rf.notes.refundRequestId;
        if (rid) {
            const mine = await PaymentTransaction.findOne({ type: 'refund', refundRequestId: String(rid) });
            if (mine) {
                if (mine.status === 'failed') {
                    await ledger.refundPayment({
                        libraryId: mine.libraryId, transactionId: mine.refundOf, amount: mine.amount, reason: mine.reason || 'Refund processed by payment gateway',
                        method: 'online', requestId: mine.refundRequestId, razorpayRefundId: rf.id, razorpayPaymentId: rf.payment_id
                    });
                }
                return; // success, or in flight (the API flow will finalize it)
            }
        }
        const orig = await PaymentTransaction.findOne({ razorpayPaymentId: rf.payment_id, type: 'collection', status: 'success' });
        if (!orig) return;
        await ledger.refundPayment({
            libraryId: orig.libraryId, transactionId: orig._id, amount: rf.amount / 100,
            reason: 'Refund processed by payment gateway', method: 'online',
            razorpayRefundId: rf.id, razorpayPaymentId: rf.payment_id
        });
    }
};

// ─────────────────────────────────────────────────────────────
// POST /v1/public/razorpay/webhook  (raw bytes captured by express.json verify -> req.rawBody)
// Fails closed. Idempotent by event id.
// ─────────────────────────────────────────────────────────────
const webhookHandler = async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
        console.error('[RAZORPAY WEBHOOK] RAZORPAY_WEBHOOK_SECRET not set - rejecting');
        return res.status(503).json({ success: false, message: 'Webhook not configured' });
    }
    const signature = req.headers['x-razorpay-signature'];
    const raw = req.rawBody;
    if (!signature || !raw) return res.status(400).json({ success: false, message: 'Missing signature or body' });
    if (!safeEqual(hmac(secret, raw), signature)) {
        console.warn('[RAZORPAY WEBHOOK] invalid signature');
        return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    const event = req.body || {};
    const p = event.payload || {};
    const entityId = (p.payment && p.payment.entity && p.payment.entity.id)
        || (p.refund && p.refund.entity && p.refund.entity.id)
        || (p.order && p.order.entity && p.order.entity.id) || '';
    const eventId = req.headers['x-razorpay-event-id'] || `${event.event}:${entityId}`;
    if (!event.event || !eventId) return res.status(400).json({ success: false, message: 'Malformed event' });

    try {
        await WebhookEvent.create({ eventId: String(eventId), event: event.event });
    } catch (e) {
        if (e.code === 11000) return res.status(200).json({ success: true, message: 'Duplicate event ignored' });
        console.error('[RAZORPAY WEBHOOK] idempotency store error', e.message);
        return res.status(500).json({ success: false, message: 'Webhook processing error' });
    }

    try {
        await handleEvent(event);
        return res.status(200).json({ success: true, message: 'Webhook processed' });
    } catch (e) {
        // permanent business errors are acknowledged; transient ones are retried by Razorpay
        if (e instanceof ApiError && e.statusCode >= 400 && e.statusCode < 500 && e.statusCode !== 409) {
            console.warn('[RAZORPAY WEBHOOK] rejected event:', e.message);
            await WebhookEvent.updateOne({ eventId: String(eventId) }, { $set: { status: 'failed', error: String(e.message).slice(0, 300) } }).catch(() => {});
            return res.status(200).json({ success: true, message: 'Event acknowledged (not applied)' });
        }
        await WebhookEvent.deleteOne({ eventId: String(eventId) }).catch(() => {});
        console.error('[RAZORPAY WEBHOOK] error:', e.message);
        return res.status(500).json({ success: false, message: 'Webhook processing error' });
    }
};

module.exports = { createOrder, verifyPayment, webhookHandler, safeEqual, hmac };
