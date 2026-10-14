const express = require('express');
const authController = require('../../controllers/auth.controller');
const adminController = require('../../controllers/admin.controller');
const { loginLimiter, otpLimiter } = require('../../middlewares/rateLimit.middleware');
const validate = require('../../middlewares/validate.middleware');
const { authValidation } = require('../../validations');
const upload = require('../../middlewares/upload.middleware');

const router = express.Router();

// Authentication endpoints
router.post('/login', loginLimiter, validate(authValidation.login), authController.login);
router.post('/send-otp', otpLimiter, validate(authValidation.sendOTP), authController.sendOTP);
router.post('/verify-otp', otpLimiter, validate(authValidation.verifyOTP), authController.verifyOTP);
router.post('/forgot-password', otpLimiter, validate(authValidation.forgotPassword), authController.forgotPassword);
router.post('/verify-reset-otp', otpLimiter, authController.verifyResetOTP);
router.post('/reset-password', loginLimiter, validate(authValidation.resetPassword), authController.resetPassword);

// Public profile images
router.get('/admin-image/:id', authController.getPublicProfileImage);
router.get('/library-image/:id', authController.getPublicProfileImage);

// Public Library Registration (Self-onboarding)
router.post('/register', upload.any(), adminController.createLibrary);

module.exports = router;
