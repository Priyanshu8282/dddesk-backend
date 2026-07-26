const express = require('express');
const authController = require('../../modules/auth/auth.controller');
const categoryController = require('../../modules/categories/category.controller');
const analyticsRoutes = require('../../modules/analytics/analytics.routes');
const studentController = require('../../modules/students/student.controller');

const router = express.Router();



const multerUpload = require('../../middlewares/upload.middleware');
const upload = multerUpload.any();

router.post('/login', authController.login);
router.post('/send-otp', authController.sendOTP);
router.post('/verify-otp', authController.verifyOTP);
router.post('/forgot-password', authController.forgotPassword);
router.post('/verify-reset-otp', authController.verifyResetOTP);
router.post('/reset-password', authController.resetPassword);



router.get('/admin-image/:id', authController.getPublicProfileImage);
router.get('/library-image/:id', authController.getPublicProfileImage);
router.get('/category-image/:id', categoryController.getPublicCategoryImage);

// ─── Visitor Analytics (Public, fire-and-forget) ──────────────────
router.use('/analytics', analyticsRoutes);

module.exports = router;
