const express = require('express');
const authController = require('../../controllers/auth.controller');
const upload = require('../../middlewares/upload.middleware');

const router = express.Router();

router.get('/me', authController.getMe);
router.put('/update-profile', upload.single('profileImage'), authController.updateProfile);
router.delete('/delete-profile-image', authController.deleteProfileImage);

module.exports = router;
