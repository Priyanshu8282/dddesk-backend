const express = require('express');
const adminController = require('../../controllers/admin.controller');
const Authorization = require('../../middlewares/authorization.middleware');
const upload = require('../../middlewares/upload.middleware');

const router = express.Router();

// Staff / Employee Routes
router.post('/create-admin', Authorization, upload.any(), adminController.createAdmin);
router.get('/get-admins', Authorization, adminController.getAdmins);

// Library admin
router.post('/create-library', Authorization, upload.any(), adminController.createLibrary);
router.get('/get-libraries', Authorization, adminController.getLibraries);
router.get('/dashboard', adminController.getDashboard);

// Shared Admin / Staff Management
router.get('/get-admin/:id', Authorization, adminController.getAdminById);
router.put('/update-admin/:id', Authorization, upload.any(), adminController.updateAdmin);
router.put('/update-status/:id', Authorization, adminController.updateAdminStatus);
router.delete('/delete-admin/:id', Authorization, adminController.deleteAdmin);

module.exports = router;
