const catchAsync = require('../utils/catchAsync');
const paymentService = require('../services/payment.service');
const ApiError = require('../utils/ApiError');

const createPayment = catchAsync(async (req, res) => {
    const payment = await paymentService.recordPayment({
        ...req.body,
        libraryId: req.user.libraryId,
        collectedBy: req.user._id
    });

    const { notifyStudent } = require('../services/firebase.service');
    notifyStudent(
        req.body.studentId,
        '💰 Payment Received',
        `₹${req.body.paidAmount || 0} payment recorded`,
        { paymentId: payment._id.toString() },
        'payment_alert'
    );

    res.status(201).json({ success: true, message: 'Payment recorded successfully', data: payment });
});

const collectPartialPayment = catchAsync(async (req, res) => {
    const { additionalAmount } = req.body;
    if (!additionalAmount || additionalAmount <= 0) throw new ApiError(400, 'additionalAmount must be positive');
    const payment = await paymentService.collectPartialPayment(req.params.paymentId, additionalAmount, req.user._id);
    res.status(200).json({ success: true, message: 'Partial payment collected successfully', data: payment });
});

const getPayments = catchAsync(async (req, res) => {
    const filter = {};
    if (req.user.userType !== 'superadmin') filter.libraryId = req.user.libraryId;
    if (req.user.userType === 'student') filter.studentId = req.user._id;
    else if (req.query.studentId) filter.studentId = req.query.studentId;
    if (req.query.status) filter.paymentStatus = req.query.status;

    const result = await paymentService.queryPayments(filter, { limit: req.query.limit, page: req.query.page });
    res.status(200).json({
        success: true,
        message: 'Payments retrieved successfully',
        data: result.payments || result.results || result,
        ...result
    });
});

const getPayment = catchAsync(async (req, res) => {
    const payment = await paymentService.getPaymentById(req.params.paymentId);
    if (!payment) throw new ApiError(404, 'Payment not found');
    // Enforce library isolation
    if (req.user.userType !== 'superadmin' &&
        payment.libraryId.toString() !== req.user.libraryId.toString()) {
        throw new ApiError(403, 'Access denied');
    }
    res.status(200).json({ success: true, message: 'Payment retrieved successfully', data: payment });
});

module.exports = { createPayment, collectPartialPayment, getPayments, getPayment };
