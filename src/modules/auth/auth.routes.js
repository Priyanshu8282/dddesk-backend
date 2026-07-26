const express = require('express');
const router = express.Router();
const authController = require('./auth.controller');
const authMiddleware = require('../../middlewares/auth.middleware');
const multerUpload = require('../../middlewares/upload.middleware');
const upload = multerUpload.any();

router.post('/login', authController.login);
router.post('/send-otp', authController.sendOTP);
router.post('/verify-otp', authController.verifyOTP);
router.post('/forgot-password', authController.forgotPassword);
router.post('/verify-reset-otp', authController.verifyResetOTP);
router.post('/reset-password', authController.resetPassword);
router.post('/vendor-login', authController.vendorLogin);
router.post('/vendor-register', upload, authController.vendorRegister);
router.get('/me', authMiddleware, authController.getMe);
router.post('/update-fcm-token', authMiddleware, authController.updateFcmToken);

module.exports = router;
