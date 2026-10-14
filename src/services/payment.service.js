const Payment = require('../models/payment.model');
const Student = require('../models/student.model');
const Plan = require('../models/plan.model');
const ApiError = require('../utils/ApiError');
const { notifyLibraryAdmins } = require('./firebase.service');

const recordPayment = async (paymentBody) => {
    const { studentId, libraryId, planId, paidAmount = 0, paymentMethod = 'cash',
        discountAmount = 0, lateFee = 0, remarks, collectedBy, paymentType = 'new' } = paymentBody;

    const student = await Student.findById(studentId);
    if (!student) throw new ApiError(404, 'Student not found');

    let totalAmount = paymentBody.totalAmount;

    if (!totalAmount && planId) {
        const plan = await Plan.findById(planId);
        if (!plan) throw new ApiError(404, 'Plan not found');
        totalAmount = plan.finalPrice || plan.price;
    }

    if (!totalAmount) throw new ApiError(400, 'totalAmount is required');

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7); // default 7-day grace

    // Period end based on plan duration
    let periodEnd = null;
    if (planId) {
        const plan = await Plan.findById(planId);
        if (plan && plan.durationDays) {
            periodEnd = new Date();
            periodEnd.setDate(periodEnd.getDate() + plan.durationDays);
        }
    }

    const payment = await Payment.create({
        studentId,
        libraryId,
        planId,
        totalAmount,
        paidAmount,
        discountAmount,
        lateFee,
        dueDate,
        paymentDate: paidAmount > 0 ? new Date() : null,
        periodStart: new Date(),
        periodEnd,
        paymentMethod,
        remarks,
        collectedBy,
        paymentType,
        createdBy: collectedBy
    });

    // Update student plan/expiry if fully or partially paid
    if (payment.paymentStatus !== 'credit') {
        const updates = {
            planId: planId || student.planId,
            planStatus: 'active',
            paymentMethod,
            paymentStatus: paidAmount >= totalAmount - discountAmount ? 'paid' : 'pending'
        };
        if (periodEnd) updates.expiryDate = periodEnd;
        await Student.findByIdAndUpdate(studentId, updates);

        notifyLibraryAdmins(
            libraryId,
            '💰 Payment Received',
            `₹${paidAmount} received from ${student.name} (${paymentMethod})`,
            {},
            'payment_received'
        );
    }

    return payment;
};

const collectPartialPayment = async (paymentId, additionalAmount, collectedBy) => {
    const payment = await Payment.findById(paymentId);
    if (!payment) throw new ApiError(404, 'Payment not found');
    if (payment.paymentStatus === 'paid') throw new ApiError(400, 'Payment is already fully paid');

    payment.paidAmount += additionalAmount;
    payment.paymentDate = new Date();
    payment.collectedBy = collectedBy;
    await payment.save(); // pre-save hook recalculates dueAmount and status

    return payment;
};

const queryPayments = async (filter, options = {}) => {
    const limit = parseInt(options.limit) || 20;
    const page = parseInt(options.page) || 1;
    const skip = (page - 1) * limit;

    const [payments, total, stats] = await Promise.all([
        Payment.find(filter)
            .populate('studentId', 'name mobile email')
            .populate('planId', 'name durationType')
            .populate('collectedBy', 'name')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Payment.countDocuments(filter),
        Payment.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: null,
                    totalCollected: { $sum: '$paidAmount' },
                    totalDue: { $sum: '$dueAmount' },
                    totalAmount: { $sum: '$totalAmount' }
                }
            }
        ])
    ]);

    return {
        data: payments,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        total,
        stats: stats[0] || { totalCollected: 0, totalDue: 0, totalAmount: 0 }
    };
};

const getPaymentById = async (id) => {
    return Payment.findById(id)
        .populate('studentId', 'name mobile email')
        .populate('planId', 'name durationType price finalPrice')
        .populate('collectedBy', 'name');
};

module.exports = { recordPayment, collectPartialPayment, queryPayments, getPaymentById };
