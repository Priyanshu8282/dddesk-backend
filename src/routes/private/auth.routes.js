const express = require('express');
const authController = require('../../controllers/auth.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { authValidation } = require('../../validations');

const router = express.Router();

// Any authenticated account (owner, staff, superadmin, student)
router.get('/me', authController.getMe);
router.put('/update-profile', upload.single('profileImage'), validate(authValidation.updateProfile), authController.updateProfile);
router.post('/change-password', validate(authValidation.changePassword), authController.changePassword);
router.put('/fcm-token', validate(authValidation.fcmToken), authController.updateFcmToken);
router.delete('/delete-profile-image', authController.deleteProfileImage);

module.exports = router;
