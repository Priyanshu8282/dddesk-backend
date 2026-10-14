const Razorpay = require('razorpay');
const crypto = require('crypto');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const Payment = require('../models/payment.model');
const Plan = require('../models/plan.model');
const Student = require('../models/student.model');
const { notifyStudent, notifyLibraryAdmins } = require('../services/firebase.service');

// ── Razorpay SDK instance ──────────────────────────────────
const razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─────────────────────────────────────────────────────────────
// 1. CREATE ORDER
//    POST /private/payments/razorpay/create-order
//    Body: { planId }
//    Auth: Student JWT
// ─────────────────────────────────────────────────────────────
const createOrder = catchAsync(async (req, res) => {
    const { planId, paymentType = 'new' } = req.body;
    const studentId = req.user.id || req.user._id;
    const libraryId = req.user.libraryId;

    if (!planId) {
        throw new ApiError(400, 'planId is required');
    }

    // Fetch plan to get price
    const plan = await Plan.findById(planId);
    if (!plan) {
        throw new ApiError(404, 'Plan not found');
    }

    const amount = plan.finalPrice || plan.price; // in INR
    const amountInPaise = Math.round(amount * 100); // Razorpay uses paise

    // Create Razorpay order
    const razorpayOrder = await razorpayInstance.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `rcpt_${studentId.toString().slice(-8)}_${Date.now().toString().slice(-8)}`,
        notes: {
            studentId: studentId.toString(),
            planId: planId.toString(),
            libraryId: libraryId?.toString() || '',
        },
    });

    // Fetch student to check existing plan expiry
    const student = await Student.findById(studentId);
    let baseDate = new Date();
    
    // If renewing the SAME plan and it hasn't expired yet, extend it from the current expiry date
    if (student && student.planId && student.planId.toString() === planId.toString() && student.expiryDate && new Date(student.expiryDate) > new Date()) {
        baseDate = new Date(student.expiryDate);
    }

    // Calculate expiry date
    const expiryDate = new Date(baseDate);
    expiryDate.setMonth(expiryDate.getMonth() + parseInt(plan.duration));

    // Save pending payment record
    await Payment.create({
        studentId,
        libraryId,
        planId,
        amount,
        paymentMethod: 'online',
        paymentStatus: 'pending',
        paymentType,
        razorpayOrderId: razorpayOrder.id,
        expiryDate,
    });

    res.status(200).json({
        success: true,
        message: 'Razorpay order created successfully',
        data: {
            orderId: razorpayOrder.id,
            amount: amountInPaise,
            currency: 'INR',
            key: process.env.RAZORPAY_KEY_ID,
            planName: plan.name,
            planAmount: amount,
        },
    });
});

// ─────────────────────────────────────────────────────────────
// 2. VERIFY PAYMENT
//    POST /private/payments/razorpay/verify-payment
//    Body: { razorpayOrderId, razorpayPaymentId, razorpaySignature }
//    Auth: Student JWT
// ─────────────────────────────────────────────────────────────
const verifyPayment = catchAsync(async (req, res) => {
    const razorpayOrderId = req.body.razorpayOrderId || req.body.razorpay_order_id;
    const razorpayPaymentId = req.body.razorpayPaymentId || req.body.razorpay_payment_id;
    const razorpaySignature = req.body.razorpaySignature || req.body.razorpay_signature;
    const studentId = req.user.id || req.user._id;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        throw new ApiError(400, 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required');
    }

    // Verify HMAC SHA256 signature
    const generatedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

    if (generatedSignature !== razorpaySignature) {
        // Mark payment failed
        await Payment.findOneAndUpdate(
            { razorpayOrderId },
            { paymentStatus: 'failed', paymentId: razorpayPaymentId }
        );
        throw new ApiError(400, 'Payment verification failed — invalid signature');
    }

    // Update payment record to paid
    const payment = await Payment.findOneAndUpdate(
        { razorpayOrderId },
        {
            paymentStatus: 'paid',
            paymentMethod: 'online',
            paymentId: razorpayPaymentId,
            razorpaySignature,
            paymentDate: new Date(),
        },
        { new: true }
    );

    if (!payment) {
        throw new ApiError(404, 'Payment record not found');
    }

    // Assign plan to student
    await Student.findByIdAndUpdate(payment.studentId, {
        planId: payment.planId,
        expiryDate: payment.expiryDate,
        paymentMethod: 'online',
        paymentStatus: 'paid',
        planStatus: 'active',
    });

    const student = await Student.findById(payment.studentId);

    // Notify student
    notifyStudent(
        payment.studentId.toString(),
        '🎉 Payment Successful!',
        `Your plan has been activated. Valid till ${payment.expiryDate?.toLocaleDateString('en-IN')}.`,
        { paymentId: payment._id.toString() },
        'payment_alert'
    );

    // Notify library admin
    if (payment.libraryId) {
        notifyLibraryAdmins(
            payment.libraryId,
            '💰 Online Payment Received',
            `₹${payment.amount} received from ${student?.name || 'Student'} via Razorpay.`,
            {},
            'payment_received'
        );
    }

    res.status(200).json({
        success: true,
        message: 'Payment verified and plan activated successfully',
        data: {
            paymentId: payment._id,
            amount: payment.amount,
            expiryDate: payment.expiryDate,
            planId: payment.planId,
        },
    });
});

// ─────────────────────────────────────────────────────────────
// 3. WEBHOOK HANDLER (fallback — no auth, raw body)
//    POST /webhook/razorpay
// ─────────────────────────────────────────────────────────────
const webhookHandler = async (req, res) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        const signature = req.headers['x-razorpay-signature'];

        if (webhookSecret && signature) {
            // Verify webhook signature using raw body
            const rawBody = req.rawBody || JSON.stringify(req.body);
            const expectedSignature = crypto
                .createHmac('sha256', webhookSecret)
                .update(rawBody)
                .digest('hex');

            if (expectedSignature !== signature) {
                console.warn('[RAZORPAY WEBHOOK] Invalid signature — ignoring');
                return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
            }
        }

        const event = req.body;
        console.log('[RAZORPAY WEBHOOK] Event received:', event.event);

        if (event.event === 'payment.captured') {
            const paymentData = event.payload.payment.entity;
            const razorpayOrderId = paymentData.order_id;
            const razorpayPaymentId = paymentData.id;

            // Check if already processed by verifyPayment
            const existing = await Payment.findOne({ razorpayOrderId, paymentStatus: 'paid' });
            if (existing) {
                console.log('[RAZORPAY WEBHOOK] Already processed, skipping');
                return res.status(200).json({ success: true, message: 'Already processed' });
            }

            // Mark as paid via webhook fallback
            const payment = await Payment.findOneAndUpdate(
                { razorpayOrderId },
                {
                    paymentStatus: 'paid',
                    paymentId: razorpayPaymentId,
                    paymentDate: new Date(),
                },
                { new: true }
            );

            if (payment) {
                await Student.findByIdAndUpdate(payment.studentId, {
                    planId: payment.planId,
                    expiryDate: payment.expiryDate,
                    paymentMethod: 'online',
                    paymentStatus: 'paid',
                    planStatus: 'active',
                });
                console.log('[RAZORPAY WEBHOOK] Payment activated via webhook for order:', razorpayOrderId);
            }
        }

        res.status(200).json({ success: true, message: 'Webhook processed successfully' });
    } catch (error) {
        console.error('[RAZORPAY WEBHOOK] Error:', error);
        res.status(500).json({ success: false, message: 'Webhook processing error' });
    }
};

module.exports = {
    createOrder,
    verifyPayment,
    webhookHandler,
};
