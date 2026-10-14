const express = require('express');
const rateLimit = require('express-rate-limit');
const authController = require('../../controllers/auth.controller');
const adminController = require('../../controllers/admin.controller');
const { loginLimiter, otpLimiter } = require('../../middlewares/rateLimit.middleware');
const validate = require('../../middlewares/validate.middleware');
const { authValidation } = require('../../validations');
const libraryValidation = require('../../validations/library.validation');
const upload = require('../../middlewares/upload.middleware');

const router = express.Router();

// Self registration is expensive (library + account + notifications) and an abuse target
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Too many registration attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Authentication endpoints
router.post('/login', loginLimiter, validate(authValidation.login), authController.login);
router.post('/send-otp', otpLimiter, validate(authValidation.sendOTP), authController.sendOTP);
router.post('/verify-otp', otpLimiter, validate(authValidation.verifyOTP), authController.verifyOTP);
router.post('/forgot-password', otpLimiter, validate(authValidation.forgotPassword), authController.forgotPassword);
router.post('/verify-reset-otp', otpLimiter, validate(authValidation.verifyResetOTP), authController.verifyResetOTP);
router.post('/reset-password', loginLimiter, validate(authValidation.resetPassword), authController.resetPassword);

// Public profile images
router.get('/admin-image/:id', authController.getPublicProfileImage);
router.get('/library-image/:id', authController.getPublicProfileImage);

// Public Library Registration (Self-onboarding). Always creates a PENDING library; role is resolved server side.
router.post('/register/send-otp', otpLimiter, validate(libraryValidation.regSendOtp), adminController.sendRegistrationOtp);
router.post('/register/verify-otp', otpLimiter, validate(libraryValidation.regVerifyOtp), adminController.verifyRegistrationOtp);
router.post('/register', registerLimiter, upload.any(), validate(libraryValidation.register), adminController.registerLibrary);

module.exports = router;
