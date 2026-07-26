const Student = require('./student.model');
const Plan = require('../plans/plan.model');
const Payment = require('../payments/payment.model');
const jwt = require('jsonwebtoken');
const config = require('../../config/config');
const ApiError = require('../../utils/ApiError');
const { notifyLibraryAdmins } = require('../../services/firebase.service');

/**
 * Register a new student
 */
const registerStudent = async (studentData, creatorInfo) => {
    const student = await Student.create({
        ...studentData,
        createdBy: creatorInfo?.id,
        planStatus: 'none'
    });
    return student;
};

/**
 * Assign a plan to a student (Status: Pending)
 */
const assignPlan = async (studentId, planData, creatorInfo) => {
    const { planId, joiningDate } = planData;
    const student = await Student.findById(studentId);
    if (!student) throw new ApiError(404, 'Student not found');

    if (student.planId && (student.planStatus === 'active' || student.planStatus === 'pending')) {
        throw new ApiError(400, `This student already has an assigned plan with status: ${student.planStatus}`);
    }

    const plan = await Plan.findById(planId);
    if (!plan) throw new ApiError(404, 'Plan not found');

    student.planId = planId;
    student.planStatus = 'pending';
    student.paymentStatus = 'pending';
    if (joiningDate) {
        student.joiningDate = joiningDate;
    }
    await student.save();

    // Check if there's already a pending payment for this student and plan
    const existingPending = await Payment.findOne({
        studentId: student._id,
        planId: plan._id,
        paymentStatus: 'pending'
    });

    if (!existingPending) {
        // Create a pending payment record
        await Payment.create({
            studentId: student._id,
            libraryId: student.libraryId,
            planId: plan._id,
            amount: plan.finalPrice || plan.price,
            paymentMethod: 'unpaid',
            paymentStatus: 'pending',
            remarks: 'Plan assigned, payment pending',
            collectedBy: creatorInfo?.id
        });
    }

    return student;
};

/**
 * Mark plan as paid (Status: Active)
 */
const markAsPaid = async (studentId, paymentData, creatorInfo) => {
    const student = await Student.findById(studentId).populate('planId');
    if (!student) throw new ApiError(404, 'Student not found');
    if (!student.planId) throw new ApiError(400, 'No plan assigned to this student');

    const plan = student.planId;
    const startDate = new Date();
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + parseInt(plan.duration));

    student.planStatus = 'active';
    student.planStartDate = startDate;
    student.expiryDate = expiryDate;
    student.paymentMethod = paymentData.paymentMethod || 'cash';
    student.paymentStatus = 'paid';
    await student.save();

    // Update the latest pending payment record or create a new one
    const existingPendingPayment = await Payment.findOne({
        studentId: student._id,
        planId: plan._id,
        paymentStatus: 'pending'
    }).sort({ createdAt: -1 });

    if (existingPendingPayment) {
        existingPendingPayment.paymentMethod = student.paymentMethod;
        existingPendingPayment.paymentStatus = 'paid';
        existingPendingPayment.paymentDate = startDate;
        existingPendingPayment.expiryDate = expiryDate;
        existingPendingPayment.remarks = paymentData.remarks || 'Payment received, plan activated';
        existingPendingPayment.collectedBy = creatorInfo?.id;
        await existingPendingPayment.save();
    } else {
        await Payment.create({
            studentId: student._id,
            libraryId: student.libraryId,
            planId: plan._id,
            amount: plan.finalPrice || plan.price,
            paymentMethod: student.paymentMethod,
            paymentStatus: 'paid',
            paymentDate: startDate,
            expiryDate: expiryDate,
            remarks: paymentData.remarks || 'Payment received, plan activated',
            collectedBy: creatorInfo?.id
        });
    }

    notifyLibraryAdmins(
        student.libraryId, 
        "💰 Payment Received", 
        `${student.name} paid ₹${plan.finalPrice || plan.price} for ${plan.name}`
    );

    return student;
};

/**
 * Student Login
 */
const loginStudent = async (identifier, password) => {
    console.log(`[DEBUG] Login attempt for identifier: ${identifier}`);
    const student = await Student.findOne({
        $or: [{ email: identifier }, { mobile: identifier }],
        isDeleted: false
    }).populate('libraryId');

    if (!student) {
        console.log(`[DEBUG] Login failed: Student not found for ${identifier}`);
        throw new ApiError(404, 'Email or Mobile number not registered');
    }

    console.log(`[DEBUG] Student found: ${student.email}, Status: ${student.status}`);

    if (student.status !== 'active') {
        console.log(`[DEBUG] Login failed: Account inactive for ${student.email}`);
        throw new ApiError(403, 'Your account is inactive. Please contact support.');
    }

    // If mobile login (no password provided), generate OTP
    if (!password && student.mobile === identifier) {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        student.otp = otp;
        await student.save();
        return { 
            message: 'OTP generated successfully', 
            otp, 
            mobile: student.mobile,
            isOTP: true 
        };
    }

    // Standard email/password login
    if (!password || !(await student.comparePassword(password))) {
        console.log(`[DEBUG] Login failed: Password mismatch for ${student.email}`);
        throw new ApiError(401, 'Invalid password. Please try again.');
    }

    console.log(`[DEBUG] Login successful for: ${student.email}`);
    
    const user = student.toObject();
    user.userType = 'student';
    // Map _id to id for frontend consistency if needed
    user.id = student._id;

    const token = jwt.sign(
        { id: student._id, type: 'student', libraryId: student.libraryId?._id },
        config.jwt.secret,
        { expiresIn: config.jwt.expiration }
    );

    return { user, token, student };
};

/**
 * Verify OTP for student login
 */
const verifyStudentOTP = async (mobile, otp) => {
    const student = await Student.findOne({ mobile, isDeleted: false }).populate('libraryId');

    if (!student) {
        throw new Error('Student not found');
    }

    if (student.otp !== otp) {
        throw new Error('Invalid OTP');
    }

    // Clear OTP after successful verification
    student.otp = null;
    await student.save();

    const user = student.toObject();
    user.userType = 'student';
    user.id = student._id;

    const token = jwt.sign(
        { id: student._id, type: 'student', libraryId: student.libraryId?._id },
        config.jwt.secret,
        { expiresIn: config.jwt.expiration }
    );

    return { user, token, student };
};

/**
 * Resend OTP for student
 */
const resendStudentOTP = async (mobile) => {
    const student = await Student.findOne({ mobile, isDeleted: false });

    if (!student) {
        throw new Error('Student not found');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    student.otp = otp;
    await student.save();

    return { 
        message: 'OTP resent successfully', 
        otp, 
        mobile: student.mobile,
        isOTP: true 
    };
};

/**
 * Query students with filters and pagination
 */
const queryStudents = async (filter, options) => {
    const { page = 1, limit = 10 } = options;
    const skip = (page - 1) * limit;

    const students = await Student.find(filter)
        .populate('libraryId', 'name libraryCode')
        .populate('planId', 'name price finalPrice duration')
        .populate({
            path: 'createdBy',
            select: 'name userType roleId',
            populate: { path: 'roleId', select: 'name' }
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

    const totalResults = await Student.countDocuments(filter);
    const totalPages = Math.ceil(totalResults / limit);

    return {
        results: students,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages,
        totalResults
    };
};

const getStudentById = async (id) => {
    const student = await Student.findById(id).populate('libraryId').populate('planId');
    if (!student || student.isDeleted) {
        throw new Error('Student not found');
    }

    // Fetch recent 3 payments
    const payments = await Payment.find({ studentId: id })
        .populate('planId', 'name')
        .sort({ createdAt: -1 })
        .limit(3);

    const studentObj = student.toObject();
    studentObj.paymentHistory = payments;

    return studentObj;
};

/**
 * Update student by ID
 */
const updateStudentById = async (id, updateBody) => {
    const student = await getStudentById(id);
    const updatePayload = { ...updateBody };
    let plan = null;

    // Calculate expiryDate if plan is changed
    const currentPlanId = student.planId?._id ? student.planId._id.toString() : student.planId?.toString();
    if (updatePayload.planId && updatePayload.planId.toString() !== currentPlanId) {
        plan = await Plan.findById(updatePayload.planId);
        if (plan) {
            const expiryDate = new Date();
            expiryDate.setMonth(expiryDate.getMonth() + parseInt(plan.duration));
            updatePayload.expiryDate = expiryDate;
        }
    }

    // Handle payment status based on method
    if (updatePayload.paymentMethod) {
        if (updatePayload.paymentMethod === 'cash') {
            updatePayload.paymentStatus = 'paid';
        } else if (updatePayload.paymentMethod === 'online' && !updatePayload.paymentStatus) {
            updatePayload.paymentStatus = 'pending';
        }
    }

    // Hash password if updating
    if (updatePayload.password) {
        const bcrypt = require('bcryptjs');
        updatePayload.password = await bcrypt.hash(updatePayload.password, 10);
    }

    const updatedStudent = await Student.findByIdAndUpdate(
        id,
        { $set: updatePayload },
        { new: true }
    ).populate('libraryId').populate('planId', 'name price finalPrice duration');

    // Create a payment record ONLY if plan was changed or payment status became paid
    const statusChangedToPaid = updatePayload.paymentStatus === 'paid' && student.paymentStatus !== 'paid';
    const statusChangedToFailed = updatePayload.paymentStatus === 'failed' && student.paymentStatus !== 'failed';

    
    if (plan || statusChangedToPaid) {
        // If status changed to paid, try to update existing pending payment first
        let updatedExisting = false;
        if (statusChangedToPaid) {
            const existingPending = await Payment.findOne({
                studentId: updatedStudent._id,
                planId: updatedStudent.planId?._id || updatedStudent.planId,
                paymentStatus: 'pending'
            }).sort({ createdAt: -1 });

            if (existingPending) {
                existingPending.paymentMethod = updatedStudent.paymentMethod;
                existingPending.paymentStatus = 'paid';
                existingPending.paymentDate = new Date();
                existingPending.expiryDate = updatedStudent.expiryDate;
                existingPending.remarks = 'Payment updated to paid';
                existingPending.collectedBy = updatedStudent.updatedBy;
                await existingPending.save();
                updatedExisting = true;
            }
        }

        if (!updatedExisting) {
            await Payment.create({
                studentId: updatedStudent._id,
                libraryId: updatedStudent.libraryId?._id || updatedStudent.libraryId,
                planId: plan?._id || updatedStudent.planId?._id || updatedStudent.planId,
                amount: plan?.finalPrice || plan?.price || 0,
                paymentMethod: updatedStudent.paymentMethod,
                paymentStatus: updatedStudent.paymentStatus,
                expiryDate: updatedStudent.expiryDate,
                remarks: plan ? 'Plan updated/renewed' : 'Payment status updated',
                collectedBy: updatedStudent.updatedBy
            });
        }
    }

    if (statusChangedToPaid) {
        notifyLibraryAdmins(
            updatedStudent.libraryId, 
            "💰 Payment Received", 
            `${updatedStudent.name} paid ₹${plan?.finalPrice || plan?.price || 0} for ${plan?.name || 'plan'}`
        );
    } else if (statusChangedToFailed) {
        notifyLibraryAdmins(
            updatedStudent.libraryId, 
            "❌ Payment Failed", 
            `${updatedStudent.name} payment failed while purchasing plan`
        );
    }

    // Fetch recent 3 payments for consistency
    const payments = await Payment.find({ studentId: id })
        .populate('planId', 'name')
        .sort({ createdAt: -1 })
        .limit(3);

    const updatedStudentObj = updatedStudent.toObject();
    updatedStudentObj.paymentHistory = payments;

    return updatedStudentObj;
};

/**
 * Delete student by ID (Soft delete)
 */
const deleteStudentById = async (id) => {
    const student = await Student.findById(id);
    if (!student || student.isDeleted) {
        throw new Error('Student not found');
    }
    student.isDeleted = true;
    await student.save();
    return student;
};
console.log("Student Service Loaded - Exporting functions");

/**
 * Get all payments for a student
 */
const getStudentPayments = async (studentId) => {
    const payments = await Payment.find({ studentId: studentId })
        .populate('planId', 'name')
        .sort({ createdAt: -1 });
    return payments;
};

/**
 * Change student password
 */
const changeStudentPassword = async (studentId, currentPassword, newPassword) => {
    const student = await Student.findById(studentId);
    if (!student) throw new ApiError(404, 'Student not found');

    // Only verify if they have a password (some might be mobile-only initially)
    if (student.password && currentPassword) {
        const isMatch = await student.comparePassword(currentPassword);
        if (!isMatch) throw new ApiError(401, 'Current password does not match');
    }

    student.password = newPassword;
    await student.save();

    return student;
};

module.exports = {
    registerStudent,
    assignPlan,
    markAsPaid,
    loginStudent,
    queryStudents,
    getStudentById,
    updateStudentById,
    deleteStudentById,
    verifyStudentOTP,
    resendStudentOTP,
    getStudentPayments,
    changeStudentPassword
};
