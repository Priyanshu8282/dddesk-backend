const express = require('express');
const catchAsync = require('../../utils/catchAsync');
const adminController = require('../admins/admin.controller');
const Authentication = require('../../middlewares/auth.middleware');
const Authorization = require('../../middlewares/authorization.middleware');
const multerUpload = require('../../middlewares/upload.middleware');
const Library = require('./library.model');

const router = express.Router();

// ─── Public ──────────────────────────────────────────────────────
router.post('/register', multerUpload.any(), adminController.createLibrary);

// ─── Profile (Self management) ───────────────────────────────────
router.get('/profile', Authentication, adminController.getAdminById);
router.put('/profile', Authentication, multerUpload.any(), adminController.updateAdmin);
router.patch('/change-password', Authentication, adminController.changePassword);

// ─── My subscription plan details ────────────────────────────────
router.get('/my-plan', Authentication, catchAsync(async (req, res) => {
    const libraryId = req.user.libraryId || req.user._id;
    const lib = await Library.findById(libraryId)
        .select('subscriptionPlan subscriptionPlanId subscriptionExpiry planLimits')
        .populate('subscriptionPlanId', 'name description monthlyPrice annualPrice features trialDays graceDays');
    if (!lib) return res.status(404).json({ success: false, message: 'Library not found' });
    const now = new Date();
    const isExpired = lib.subscriptionExpiry ? lib.subscriptionExpiry < now : false;
    res.json({ success: true, data: { ...lib.toObject(), isExpired } });
}));

// ─── Admin management ────────────────────────────────────────────
router.get('/all', Authentication, adminController.getLibraries);
router.get('/:id', Authentication, adminController.getAdminById);
router.put('/:id', Authentication, Authorization, multerUpload.any(), adminController.updateAdmin);
router.patch('/status/:id', Authentication, Authorization, adminController.updateAdminStatus);
router.delete('/:id', Authentication, Authorization, adminController.deleteAdmin);

module.exports = router;
