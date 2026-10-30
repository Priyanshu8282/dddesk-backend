const express = require('express');
const authController = require('../../controllers/auth.controller');
const adminController = require('../../controllers/admin.controller');
const { loginLimiter, accountLoginLimiter, otpLimiter, accountOtpLimiter, otpVerifyLimiter, accountOtpVerifyLimiter, refreshLimiter, registerLimiter } = require('../../middlewares/rateLimit.middleware');
const validate = require('../../middlewares/validate.middleware');
const { authValidation } = require('../../validations');
const libraryValidation = require('../../validations/library.validation');
const upload = require('../../middlewares/upload.middleware');
const { requireHuman, requireHumanSilent, requireHumanLegacy, requireHumanMobile, acceptHumanMobile } = require('../../middlewares/humanCheck.middleware');

const router = express.Router();

// Authentication endpoints
router.post('/login', loginLimiter, accountLoginLimiter, requireHuman, validate(authValidation.login), authController.login);
// Session cookie endpoints (CSRF-checked inside the service: custom header + allowed Origin)
router.post('/refresh', refreshLimiter, authController.refresh);
router.post('/logout', refreshLimiter, authController.logout);
router.post('/send-otp', otpLimiter, accountOtpLimiter, requireHumanMobile, validate(authValidation.sendOTP), authController.sendOTP);
router.post('/verify-otp', otpVerifyLimiter, accountOtpVerifyLimiter, acceptHumanMobile, validate(authValidation.verifyOTP), authController.verifyOTP);
router.post('/forgot-password', otpLimiter, accountOtpLimiter, requireHumanSilent, validate(authValidation.forgotPassword), authController.forgotPassword);
router.post('/verify-reset-otp', otpVerifyLimiter, accountOtpVerifyLimiter, validate(authValidation.verifyResetOTP), authController.verifyResetOTP);
router.post('/reset-password', loginLimiter, accountOtpVerifyLimiter, validate(authValidation.resetPassword), authController.resetPassword);

// Public profile images
router.get('/admin-image/:id', authController.getPublicProfileImage);
router.get('/library-image/:id', authController.getPublicProfileImage);

// Public Library Registration (Self-onboarding). Always creates a PENDING library; role is resolved server side.
router.post('/register/send-otp', otpLimiter, accountOtpLimiter, requireHuman, validate(libraryValidation.regSendOtp), adminController.sendRegistrationOtp);
router.post('/register/verify-otp', otpVerifyLimiter, accountOtpVerifyLimiter, validate(libraryValidation.regVerifyOtp), adminController.verifyRegistrationOtp);
router.post('/register', registerLimiter, requireHumanLegacy, upload.publicFields([{ name: 'profileImage', maxCount: 1 }, { name: 'logo', maxCount: 1 }, { name: 'photos', maxCount: 5 }]), validate(libraryValidation.register), adminController.registerLibrary);

module.exports = router;
