const Payment = require('./payment.model');
const Student = require('../students/student.model');
const Plan = require('../plans/plan.model');
const ApiError = require('../../utils/ApiError');

const { notifyLibraryAdmins } = require('../../services/firebase.service');

/**
 * Record a new payment
 * @param {Object} paymentBody
 * @returns {Promise<Payment>}
 */
const recordPayment = async (paymentBody) => {
    const student = await Student.findById(paymentBody.studentId);
    if (!student) {
        throw new ApiError(404, 'Student not found');
    }

    const plan = await Plan.findById(paymentBody.planId);
    if (!plan) {
        throw new ApiError(404, 'Plan not found');
    }

    // Calculate expiry date based on plan duration (months)
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + parseInt(plan.duration));

    const payment = await Payment.create({
        ...paymentBody,
        amount: plan.finalPrice || plan.price,
        expiryDate
    });

    // If payment is paid, update student record
    if (payment.paymentStatus === 'paid') {
        await Student.findByIdAndUpdate(paymentBody.studentId, {
            planId: payment.planId,
            expiryDate: payment.expiryDate,
            paymentMethod: payment.paymentMethod,
            paymentStatus: 'paid'
        });

        // Notify Library Admin
        notifyLibraryAdmins(
            paymentBody.libraryId,
            "💰 Payment Received",
            `A payment of ₹${payment.amount} was received from ${student.name} (${payment.paymentMethod}).`,
            {},
            'payment_received'
        );
    } else if (payment.paymentStatus === 'failed') {
        notifyLibraryAdmins(
            paymentBody.libraryId,
            "❌ Payment Failed",
            `An online payment attempt of ₹${payment.amount} by ${student.name} failed.`,
            {},
            'payment_failed'
        );
    }

    return payment;
};

/**
 * Query for payments with pagination
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Pagination options
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<Object>}
 */
const queryPayments = async (filter, options = {}) => {
    const limit = parseInt(options.limit, 10) || 10;
    const page = parseInt(options.page, 10) || 1;
    const skip = (page - 1) * limit;

    const totalResults = await Payment.countDocuments(filter);
    const payments = await Payment.find(filter)
        .populate('studentId', 'name mobile email')
        .populate('planId', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

    // Calculate stats robustly using Mongoose to handle all casting and type issues
    const paidFilter = { ...filter, paymentStatus: 'paid' };
    
    // Fetch only the necessary fields for calculation to minimize memory usage
    const allPaidPayments = await Payment.find(paidFilter).select('amount createdAt');
    
    let totalRevenue = 0;
    let todayCollection = 0;
    
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    allPaidPayments.forEach(p => {
        // Parse float ensures that even if amount is stored as string in DB, it sums correctly
        const amt = parseFloat(p.amount) || 0;
        totalRevenue += amt;
        
        if (p.createdAt >= startOfToday && p.createdAt <= endOfToday) {
            todayCollection += amt;
        }
    });

    // paidStudentsCount
    const paidStudentsCount = (await Payment.distinct('studentId', paidFilter)).length;

    return {
        results: payments,
        page,
        limit,
        totalPages: Math.ceil(totalResults / limit),
        totalResults,
        stats: {
            totalRevenue,
            todayCollection,
            paidStudentsCount
        }
    };
};

/**
 * Get payment by id
 * @param {ObjectId} id
 * @returns {Promise<Payment>}
 */
const getPaymentById = async (id) => {
    return Payment.findById(id).populate('studentId').populate('planId');
};

module.exports = {
    recordPayment,
    queryPayments,
    getPaymentById
};
