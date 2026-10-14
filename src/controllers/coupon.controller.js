const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const { tenantId } = require('../middlewares/access.middleware');
const couponService = require('../services/coupon.service');

const getLibraryId = (req) => {
    const id = tenantId(req);
    if (!id) throw new ApiError(400, 'Library context is required');
    return id;
};

exports.createCoupon = catchAsync(async (req, res) => {
    const libraryId = getLibraryId(req);
    const coupon = await couponService.createCoupon(req.body, libraryId, req.user._id);
    audit(req, 'coupon.create', 'Coupon', coupon._id, { code: coupon.code });
    res.status(201).json({ success: true, message: 'Coupon created successfully', data: coupon });
});

exports.getCoupons = catchAsync(async (req, res) => {
    const result = await couponService.listCoupons(getLibraryId(req), req.query);
    res.status(200).json({
        success: true,
        message: 'Coupons retrieved successfully',
        data: result.data,
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
        limit: result.limit
    });
});

// Students and staff: active, in-date coupons only
exports.getActiveCoupons = catchAsync(async (req, res) => {
    const coupons = await couponService.getActiveCoupons(getLibraryId(req), req.query.planId);
    res.status(200).json({ success: true, message: 'Active coupons retrieved successfully', data: coupons });
});

exports.getCouponById = catchAsync(async (req, res) => {
    const coupon = await couponService.getCouponById(req.params.id, getLibraryId(req));
    res.status(200).json({ success: true, message: 'Coupon details retrieved successfully', data: coupon });
});

exports.updateCoupon = catchAsync(async (req, res) => {
    const coupon = await couponService.updateCoupon(req.params.id, getLibraryId(req), req.body);
    audit(req, 'coupon.update', 'Coupon', coupon._id, { fields: Object.keys(req.body || {}) });
    res.status(200).json({ success: true, message: 'Coupon updated successfully', data: coupon });
});

exports.toggleStatus = catchAsync(async (req, res) => {
    const coupon = await couponService.toggleCouponStatus(req.params.id, getLibraryId(req));
    audit(req, 'coupon.toggle', 'Coupon', coupon._id, { isActive: coupon.isActive });
    res.status(200).json({
        success: true,
        message: `Coupon is now ${coupon.isActive ? 'active' : 'inactive'}`,
        data: coupon
    });
});

// Students validate for themselves only; staff may name a student of their library
exports.validateCoupon = catchAsync(async (req, res) => {
    const libraryId = getLibraryId(req);
    const studentId = req.userType === 'student' ? req.user._id : req.body.studentId;
    if (req.userType !== 'student' && studentId) {
        const Student = require('../models/student.model');
        const ok = await Student.exists({ _id: studentId, libraryId });
        if (!ok) throw new ApiError(404, 'Student not found');
    }

    const result = await couponService.validateCoupon({
        code: req.body.code,
        amount: req.body.amount,
        planId: req.body.planId,
        referrerId: req.body.referrerId,
        studentId,
        libraryId
    });

    res.status(200).json({ success: true, message: 'Coupon applied successfully', data: result });
});

exports.deleteCoupon = catchAsync(async (req, res) => {
    await couponService.deleteCoupon(req.params.id, getLibraryId(req));
    audit(req, 'coupon.delete', 'Coupon', req.params.id);
    res.status(200).json({ success: true, message: 'Coupon deleted successfully' });
});
