const express = require('express');
const catchAsync = require('../../utils/catchAsync');
const adminController = require('../../controllers/admin.controller');
const multerUpload = require('../../middlewares/upload.middleware');
const Library = require('../../models/library.model');
const Authorization = require('../../middlewares/authorization.middleware');

const router = express.Router();

// Profile management for current library
router.get('/profile', adminController.getAdminById);
router.put('/profile', multerUpload.any(), adminController.updateAdmin);
router.patch('/change-password', adminController.changePassword);

// My subscription plan details
router.get('/my-plan', catchAsync(async (req, res) => {
    const libraryId = req.user.libraryId || req.user._id;
    const lib = await Library.findById(libraryId)
        .select('subscriptionPlan subscriptionPlanId subscriptionExpiry planLimits')
        .populate('subscriptionPlanId', 'name description monthlyPrice annualPrice features trialDays graceDays');
    if (!lib) return res.status(404).json({ success: false, message: 'Library not found' });
    const now = new Date();
    const isExpired = lib.subscriptionExpiry ? lib.subscriptionExpiry < now : false;
    res.json({ success: true, data: { ...lib.toObject(), isExpired } });
}));

// Admin management
router.get('/all', adminController.getLibraries);
router.get('/:id', adminController.getAdminById);
router.put('/:id', Authorization, multerUpload.any(), adminController.updateAdmin);
router.patch('/status/:id', Authorization, adminController.updateAdminStatus);
router.delete('/:id', Authorization, adminController.deleteAdmin);

module.exports = router;
