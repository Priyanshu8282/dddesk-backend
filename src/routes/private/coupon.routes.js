const express = require('express');
const router = express.Router();
const couponController = require('../../controllers/coupon.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requirePermission } = require('../../middlewares/access.middleware');
const MANAGE = ['fees.offers', 'MANAGE_COUPONS'];
const { couponValidation } = require('../../validations');

// Student + staff: list active coupons, validate a code (students validate for themselves only)
router.get('/active', couponController.getActiveCoupons);
router.post('/validate', validate(couponValidation.validateCoupon), couponController.validateCoupon);

// Staff-only management (mounted at /coupons and /offers)
router.get('/', requireStaff, requirePermission(...MANAGE), validate(couponValidation.queryCoupons), couponController.getCoupons);
router.post('/', requireStaff, requirePermission(...MANAGE), validate(couponValidation.createCoupon), couponController.createCoupon);
router.get('/:id', requireStaff, requirePermission(...MANAGE), couponController.getCouponById);
router.put('/:id', requireStaff, requirePermission(...MANAGE), validate(couponValidation.updateCoupon), couponController.updateCoupon);
router.patch('/:id/toggle', requireStaff, requirePermission(...MANAGE), couponController.toggleStatus);
router.delete('/:id', requireStaff, requirePermission(...MANAGE), couponController.deleteCoupon);

module.exports = router;
