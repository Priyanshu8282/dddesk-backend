const express = require('express');
const adminController = require('../admins/admin.controller');
const Authentication = require('../../middlewares/auth.middleware');
const Authorization = require('../../middlewares/authorization.middleware');
const multerUpload = require('../../middlewares/upload.middleware');

const router = express.Router();

// ─── Public ──────────────────────────────────────────────────────
router.post('/register', multerUpload.any(), adminController.createLibrary);

// ─── Profile (Self management) ───────────────────────────────────
router.get('/profile', Authentication, adminController.getAdminById); // Reusing getAdminById for profile
router.put('/profile', Authentication, multerUpload.any(), adminController.updateAdmin);
router.patch('/change-password', Authentication, adminController.changePassword);

// ─── Admin management ────────────────────────────────────────────
router.get('/all', Authentication, adminController.getLibraries);
router.get('/:id', Authentication, adminController.getAdminById);
router.put('/:id', Authentication, Authorization, multerUpload.any(), adminController.updateAdmin);
router.patch('/status/:id', Authentication, Authorization, adminController.updateAdminStatus);
router.delete('/:id', Authentication, Authorization, adminController.deleteAdmin);

module.exports = router;
