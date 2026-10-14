const mongoose = require('mongoose');
const Coupon = require('../models/coupon.model');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');
const pick = require('../utils/pick');

const CREATE_FIELDS = ['title', 'code', 'description', 'discountType', 'discountValue', 'maxDiscountAmount', 'minOrderAmount', 'applicablePlans', 'offerType', 'startDate', 'endDate', 'usageLimit', 'perStudentLimit', 'isActive'];
const UPDATE_FIELDS = CREATE_FIELDS;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const parsePlanIds = (v) => {
    if (v === undefined || v === null) return v;
    let arr = v;
    if (typeof v === 'string') {
        try { arr = JSON.parse(v); } catch (e) { arr = v.split(','); }
    }
    if (!Array.isArray(arr)) arr = [arr];
    return arr.map((x) => String(x).trim()).filter(Boolean);
};

// Every applicable plan id must be a valid plan of THIS library
const validatePlanIds = async (ids, libraryId) => {
    const Plan = require('../models/plan.model');
    if (!ids || ids.length === 0) return [];
    for (const id of ids) {
        if (!mongoose.isValidObjectId(id)) throw new ApiError(400, `Invalid plan id "${id}"`);
    }
    const found = await Plan.countDocuments({ _id: { $in: ids }, libraryId });
    if (found !== new Set(ids).size) throw new ApiError(400, 'One or more applicable plans do not belong to this library');
    return ids;
};

const checkDates = (start, end) => {
    if (start && end && new Date(end) < new Date(start)) throw new ApiError(400, 'endDate must be after startDate');
};

/**
 * Create a new coupon for the library
 */
exports.createCoupon = async (data, libraryId, createdBy) => {
    const formattedCode = String(data.code || '').trim().toUpperCase();
    if (!formattedCode) throw new ApiError(400, 'Coupon code is required');

    const existing = await Coupon.findOne({ libraryId, code: formattedCode, isDeleted: false });
    if (existing) {
        throw new ApiError(400, `Coupon with code "${formattedCode}" already exists for this library`);
    }

    const payload = {
        ...pick(data, CREATE_FIELDS),
        code: formattedCode,
        libraryId,
        createdBy
    };

    if (payload.applicablePlans !== undefined) {
        payload.applicablePlans = await validatePlanIds(parsePlanIds(payload.applicablePlans), libraryId);
    }
    checkDates(payload.startDate, payload.endDate);
    if (payload.discountType === 'percentage' && payload.discountValue > 100) {
        throw new ApiError(400, 'Percentage discount cannot exceed 100');
    }

    let coupon;
    try {
        coupon = await Coupon.create(payload);
    } catch (e) {
        if (e && e.code === 11000) throw new ApiError(400, `Coupon with code "${formattedCode}" already exists for this library`);
        throw e;
    }
    return Coupon.findById(coupon._id)
        .populate('applicablePlans', 'name price durationDays')
        .populate('createdBy', 'name email');
};

/**
 * List coupons with filtering, search, and pagination
 */
exports.listCoupons = async (libraryId, query = {}) => {
    const filter = { libraryId, isDeleted: false };
    const now = new Date();

    if (query.status === 'active') {
        filter.isActive = true;
        filter.endDate = { $gte: now };
    } else if (query.status === 'expired') {
        filter.endDate = { $lt: now };
    } else if (query.status === 'upcoming') {
        filter.startDate = { $gt: now };
    }

    if (query.offerType) {
        filter.offerType = String(query.offerType);
    }

    if (query.search && String(query.search).trim()) {
        const regex = new RegExp(escapeRegex(String(query.search).trim()), 'i');
        filter.$or = [{ code: regex }, { title: regex }];
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
        Coupon.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('applicablePlans', 'name price')
            .populate('createdBy', 'name'),
        Coupon.countDocuments(filter)
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit), limit };
};

/**
 * Get active valid coupons for student / admission selection.
 * usedBy is never exposed here.
 */
exports.getActiveCoupons = async (libraryId, planId = null) => {
    const now = new Date();
    const filter = {
        libraryId,
        isActive: true,
        isDeleted: false,
        startDate: { $lte: now },
        endDate: { $gte: now }
    };

    let coupons = await Coupon.find(filter)
        .select('title code description discountType discountValue maxDiscountAmount minOrderAmount applicablePlans offerType endDate usageLimit usageCount')
        .populate('applicablePlans', 'name price');

    coupons = coupons.filter(c => c.usageLimit === null || c.usageLimit === undefined || c.usageCount < c.usageLimit);

    if (planId) {
        coupons = coupons.filter(c => {
            if (!c.applicablePlans || c.applicablePlans.length === 0) return true;
            return c.applicablePlans.some(p => p._id.toString() === planId.toString());
        });
    }

    return coupons.map((c) => {
        const o = c.toObject();
        delete o.usageCount;
        delete o.usageLimit;
        return o;
    });
};

exports.getCouponById = async (id, libraryId) => {
    const coupon = await Coupon.findOne({ _id: id, libraryId, isDeleted: false })
        .populate('applicablePlans', 'name price durationDays')
        .populate('createdBy', 'name email')
        .populate('usedBy.studentId', 'name mobile email rollNumber');

    if (!coupon) {
        throw new ApiError(404, 'Coupon not found');
    }
    return coupon;
};

exports.updateCoupon = async (id, libraryId, rawBody) => {
    const coupon = await Coupon.findOne({ _id: id, libraryId, isDeleted: false });
    if (!coupon) {
        throw new ApiError(404, 'Coupon not found');
    }
    const updateBody = pick(rawBody, UPDATE_FIELDS);

    if (updateBody.code) {
        const formattedCode = String(updateBody.code).trim().toUpperCase();
        if (formattedCode !== coupon.code) {
            const collision = await Coupon.findOne({ libraryId, code: formattedCode, _id: { $ne: id }, isDeleted: false });
            if (collision) {
                throw new ApiError(400, `Coupon with code "${formattedCode}" already exists`);
            }
        }
        updateBody.code = formattedCode;
    }

    if (updateBody.applicablePlans !== undefined) {
        updateBody.applicablePlans = await validatePlanIds(parsePlanIds(updateBody.applicablePlans), libraryId);
    }
    checkDates(updateBody.startDate || coupon.startDate, updateBody.endDate || coupon.endDate);
    const dtype = updateBody.discountType || coupon.discountType;
    const dval = updateBody.discountValue !== undefined ? updateBody.discountValue : coupon.discountValue;
    if (dtype === 'percentage' && dval > 100) throw new ApiError(400, 'Percentage discount cannot exceed 100');

    Object.keys(updateBody).forEach(field => {
        if (updateBody[field] !== undefined) coupon[field] = updateBody[field];
    });

    try {
        await coupon.save();
    } catch (e) {
        if (e && e.code === 11000) throw new ApiError(400, 'A coupon with this code already exists');
        throw e;
    }
    return exports.getCouponById(id, libraryId);
};

exports.toggleCouponStatus = async (id, libraryId) => {
    const coupon = await Coupon.findOne({ _id: id, libraryId, isDeleted: false });
    if (!coupon) {
        throw new ApiError(404, 'Coupon not found');
    }
    coupon.isActive = !coupon.isActive;
    await coupon.save();
    return coupon;
};

exports.deleteCoupon = async (id, libraryId) => {
    const coupon = await Coupon.findOne({ _id: id, libraryId, isDeleted: false });
    if (!coupon) {
        throw new ApiError(404, 'Coupon not found');
    }
    coupon.isDeleted = true;
    await coupon.save();
    return true;
};

/**
 * Core validation engine: validate coupon and compute the discount SERVER-SIDE.
 * Offer rules:
 *  - new_student / first_month: student must have no prior paid membership charge
 *  - referral: a valid referrerId (another student of this library) is required
 */
exports.validateCoupon = async ({ code, amount, planId, studentId, libraryId, referrerId }) => {
    const Payment = require('../models/payment.model');
    const Student = require('../models/student.model');
    if (!code) throw new ApiError(400, 'Coupon code is required');
    const formattedCode = String(code).trim().toUpperCase();
    const coupon = await Coupon.findOne({ libraryId, code: formattedCode, isDeleted: false });

    if (!coupon) throw new ApiError(404, `Coupon code "${formattedCode}" is invalid`);
    if (!coupon.isActive) throw new ApiError(400, `Coupon code "${formattedCode}" is currently inactive`);

    const now = new Date();
    if (coupon.startDate && now < coupon.startDate) {
        throw new ApiError(400, `Coupon code "${formattedCode}" is not active yet`);
    }
    if (now > coupon.endDate) {
        throw new ApiError(400, `Coupon code "${formattedCode}" has expired`);
    }

    if (coupon.usageLimit !== null && coupon.usageLimit !== undefined && coupon.usageCount >= coupon.usageLimit) {
        throw new ApiError(400, `Coupon code "${formattedCode}" has reached its total usage limit`);
    }

    const originalAmount = Number(amount) || 0;
    if (originalAmount <= 0) throw new ApiError(400, 'Amount must be greater than 0');
    if (coupon.minOrderAmount && originalAmount < coupon.minOrderAmount) {
        throw new ApiError(400, `Minimum fee amount of ₹${coupon.minOrderAmount} required to use coupon "${formattedCode}"`);
    }

    if (coupon.applicablePlans && coupon.applicablePlans.length > 0) {
        if (!planId) {
            throw new ApiError(400, 'This coupon is only applicable to specific membership plans');
        }
        const matchesPlan = coupon.applicablePlans.some(p => p.toString() === planId.toString());
        if (!matchesPlan) {
            throw new ApiError(400, `Coupon code "${formattedCode}" is not applicable to the selected plan`);
        }
    }

    if (studentId && coupon.perStudentLimit) {
        const studentUses = coupon.usedBy.filter(
            u => u.studentId && u.studentId.toString() === studentId.toString()
        ).length;
        if (studentUses >= coupon.perStudentLimit) {
            throw new ApiError(400, `Coupon "${formattedCode}" was already used the maximum allowed (${coupon.perStudentLimit}) time(s)`);
        }
    }

    // Offer-type rules
    if (['new_student', 'first_month', 'referral'].includes(coupon.offerType) && !studentId) {
        throw new ApiError(400, 'A student is required to apply this offer');
    }
    if (coupon.offerType === 'new_student' || coupon.offerType === 'first_month') {
        const prior = await Payment.countDocuments({
            libraryId,
            studentId,
            planId: { $exists: true, $ne: null },
            paidAmount: { $gt: 0 },
            paymentStatus: { $nin: ['cancelled', 'refunded'] }
        });
        if (prior > 0) throw new ApiError(400, 'This offer is only for students with no previous paid membership');
    }
    if (coupon.offerType === 'referral') {
        if (!referrerId || !mongoose.isValidObjectId(referrerId) || String(referrerId) === String(studentId)) {
            throw new ApiError(400, 'A valid referring student is required for this referral offer');
        }
        const ref = await Student.findOne({ _id: referrerId, libraryId });
        if (!ref) throw new ApiError(400, 'Referring student not found in this library');
    }

    let discountAmount = 0;
    if (coupon.discountType === 'flat') {
        discountAmount = Math.min(coupon.discountValue, originalAmount);
    } else if (coupon.discountType === 'percentage') {
        const calculated = (originalAmount * coupon.discountValue) / 100;
        discountAmount = coupon.maxDiscountAmount ? Math.min(calculated, coupon.maxDiscountAmount) : calculated;
        discountAmount = Math.min(discountAmount, originalAmount);
    }

    discountAmount = r2(discountAmount);
    const finalAmount = Math.max(0, r2(originalAmount - discountAmount));

    return {
        valid: true,
        coupon: {
            _id: coupon._id,
            code: coupon.code,
            title: coupon.title,
            offerType: coupon.offerType,
            discountType: coupon.discountType,
            discountValue: coupon.discountValue,
            maxDiscountAmount: coupon.maxDiscountAmount
        },
        originalAmount,
        discountAmount,
        finalAmount
    };
};

/**
 * Atomically redeem a coupon: usageLimit and per-student limit are enforced inside the
 * update filter so concurrent redemptions cannot exceed them. Returns the coupon or null.
 */
exports.recordCouponUsage = async (couponId, libraryId, studentId, paymentId, discountApplied) => {
    const sid = new mongoose.Types.ObjectId(String(studentId));
    const now = new Date();
    return Coupon.findOneAndUpdate(
        {
            _id: couponId,
            libraryId,
            isDeleted: false,
            isActive: true,
            endDate: { $gte: now },
            $expr: {
                $and: [
                    { $or: [{ $eq: [{ $ifNull: ['$usageLimit', null] }, null] }, { $lt: ['$usageCount', '$usageLimit'] }] },
                    {
                        $or: [
                            { $eq: [{ $ifNull: ['$perStudentLimit', null] }, null] },
                            { $lt: [{ $size: { $filter: { input: { $ifNull: ['$usedBy', []] }, as: 'u', cond: { $eq: ['$$u.studentId', sid] } } } }, '$perStudentLimit'] }
                        ]
                    }
                ]
            }
        },
        {
            $inc: { usageCount: 1 },
            $push: {
                usedBy: {
                    studentId: sid,
                    paymentId,
                    discountApplied: Number(discountApplied) || 0,
                    usedAt: now
                }
            }
        },
        { new: true }
    );
};

/** Undo a redemption (used when the charge could not be created). */
exports.releaseCouponUsage = async (couponId, libraryId, paymentId) =>
    Coupon.findOneAndUpdate(
        { _id: couponId, libraryId, 'usedBy.paymentId': paymentId },
        { $inc: { usageCount: -1 }, $pull: { usedBy: { paymentId } } },
        { new: true }
    );
