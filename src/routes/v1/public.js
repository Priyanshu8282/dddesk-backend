const express = require('express');
const authController = require('../../modules/auth/auth.controller');
const { loginLimiter, otpLimiter } = require('../../middlewares/rateLimit.middleware');

const router = express.Router();

router.post('/login', loginLimiter, authController.login);
router.post('/send-otp', otpLimiter, authController.sendOTP);
router.post('/verify-otp', otpLimiter, authController.verifyOTP);
router.post('/forgot-password', otpLimiter, authController.forgotPassword);
router.post('/verify-reset-otp', otpLimiter, authController.verifyResetOTP);
router.post('/reset-password', loginLimiter, authController.resetPassword);

router.get('/admin-image/:id', authController.getPublicProfileImage);
router.get('/library-image/:id', authController.getPublicProfileImage);

module.exports = router;
