const catchAsync = require('../../utils/catchAsync');
const paymentService = require('./payment.service');
const ApiError = require('../../utils/ApiError');

const createPayment = catchAsync(async (req, res) => {
    const paymentBody = {
        ...req.body,
        libraryId: req.user.libraryId,
        collectedBy: req.user._id
    };
    const payment = await paymentService.recordPayment(paymentBody);

    // Notify Student
    const { notifyStudent } = require('../../services/firebase.service');
    notifyStudent(
        paymentBody.studentId,
        "💰 Payment Successful",
        `₹${paymentBody.amount} payment received successfully`,
        { paymentId: payment._id.toString() },
        'payment_alert'
    );

    res.status(201).json({
        success: true,
        message: 'Payment recorded successfully',
        data: payment
    });
});

const getPayments = catchAsync(async (req, res) => {
    const filter = {};
    if (req.user.userType !== 'superadmin') {
        filter.libraryId = req.user.libraryId;
    }
    if (req.user.userType === 'student') {
        filter.studentId = req.user._id;
    } else if (req.query.studentId) {
        filter.studentId = req.query.studentId;
    }
    const options = {
        limit: req.query.limit,
        page: req.query.page
    };
    const result = await paymentService.queryPayments(filter, options);
    res.status(200).json({
        success: true,
        message: 'Payments fetched successfully',
        data: result
    });
});

const getPayment = catchAsync(async (req, res) => {
    const payment = await paymentService.getPaymentById(req.params.paymentId);
    if (!payment) {
        throw new ApiError(404, 'Payment not found');
    }
    res.status(200).json({
        success: true,
        message: 'Payment fetched successfully',
        data: payment
    });
});

module.exports = {
    createPayment,
    getPayments,
    getPayment
};
