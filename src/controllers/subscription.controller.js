const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const svc = require('../services/subscription.service');

// Owner: own library only
exports.myPayments = catchAsync(async (req, res) => {
    if (!req.libraryId) throw new ApiError(400, 'Library context is required');
    const r = await svc.listPayments(req.libraryId, req.query);
    res.status(200).json({ success: true, message: 'Subscription payments retrieved successfully', ...r });
});

exports.createOrder = catchAsync(async (req, res) => {
    if (!req.libraryId) throw new ApiError(400, 'Library context is required');
    const data = await svc.createOrder({
        libraryId: req.libraryId, platformPlanId: req.body.platformPlanId, period: req.body.period, userId: req.user._id
    });
    audit(req, 'subscription.order.create', 'PlatformPayment', data.paymentRecordId, { amount: data.amountInr, period: data.period });
    res.status(200).json({ success: true, message: 'Subscription order created successfully', data });
});

exports.verify = catchAsync(async (req, res) => {
    if (!req.libraryId) throw new ApiError(400, 'Library context is required');
    const b = req.body;
    const { payment, alreadyProcessed } = await svc.verifyPayment({
        libraryId: req.libraryId,
        orderId: b.razorpayOrderId || b.razorpay_order_id,
        paymentId: b.razorpayPaymentId || b.razorpay_payment_id,
        signature: b.razorpaySignature || b.razorpay_signature,
        req
    });
    res.status(200).json({
        success: true,
        message: alreadyProcessed ? 'Payment already verified' : 'Subscription payment verified',
        alreadyProcessed,
        data: { id: payment._id, status: payment.status, invoiceNo: payment.invoiceNo, periodEnd: payment.periodEnd }
    });
});

// Super admin
exports.listAll = catchAsync(async (req, res) => {
    const r = await svc.listSubscriptions(req.query);
    res.status(200).json({ success: true, message: 'Subscriptions retrieved successfully', ...r });
});

exports.libraryPayments = catchAsync(async (req, res) => {
    const r = await svc.listPayments(req.params.libraryId, req.query);
    res.status(200).json({ success: true, message: 'Subscription payments retrieved successfully', ...r });
});

// ---- Plan lifecycle (owner) ----
const planSvc = require('../services/subscriptionPlan.service');
const needLibrary = (req) => { if (!req.libraryId) throw new ApiError(400, 'Library context is required'); };

exports.getSubscription = catchAsync(async (req, res) => {
    needLibrary(req);
    const data = await planSvc.getSubscription(req.libraryId);
    res.status(200).json({ success: true, message: 'Subscription retrieved successfully', data });
});

exports.changePlan = catchAsync(async (req, res) => {
    needLibrary(req);
    const { platformPlanId, billingCycle, preview } = req.body;
    const data = await planSvc.changePlan({ req, libraryId: req.libraryId, platformPlanId, billingCycle, preview });
    res.status(200).json({ success: true, message: data.message || (preview ? 'Plan change preview' : 'Plan change processed'), data });
});

exports.cancel = catchAsync(async (req, res) => {
    needLibrary(req);
    const data = await planSvc.cancel({ req, libraryId: req.libraryId, reason: req.body.reason });
    res.status(200).json({ success: true, message: 'Subscription will end at the end of the current period', data });
});

exports.resume = catchAsync(async (req, res) => {
    needLibrary(req);
    const data = await planSvc.resume({ req, libraryId: req.libraryId });
    res.status(200).json({ success: true, message: 'Cancellation removed; your subscription will continue', data });
});
