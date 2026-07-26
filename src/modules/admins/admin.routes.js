const express = require('express');
const router = express.Router();
const adminController = require('./admin.controller');
const Authentication = require('../../middlewares/auth.middleware');
const Authorization = require('../../middlewares/authorization.middleware');
const upload = require('../../middlewares/upload.middleware');

// ─── Staff / Employee Routes ─────────────────────────────────────
router.post('/create-admin', Authentication, Authorization, upload.any(), adminController.createAdmin);
router.get('/get-admins', Authentication, Authorization, adminController.getAdmins);

// ─── Admin────────────────────────────────────────
router.post('/create-library', Authentication, Authorization, upload.any(), adminController.createLibrary);
router.get('/get-libraries', Authentication, Authorization, adminController.getLibraries);
router.get('/dashboard', Authentication, adminController.getDashboard);

// ─── Shared Admin Management ─────────────────────────────────────
router.get('/get-admin/:id', Authentication, Authorization, adminController.getAdminById);
router.put('/update-admin/:id', Authentication, Authorization, upload.any(), adminController.updateAdmin);
router.put('/update-status/:id', Authentication, Authorization, adminController.updateAdminStatus);
router.delete('/delete-admin/:id', Authentication, Authorization, adminController.deleteAdmin);

module.exports = router;
