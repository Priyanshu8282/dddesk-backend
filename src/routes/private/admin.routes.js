const express = require('express');
const adminController = require('../../controllers/admin.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireOwner, requireSuperAdmin, requirePermission, blockImpersonation } = require('../../middlewares/access.middleware');
const adminValidation = require('../../validations/admin.validation');
const { superCreateLibrary } = require('../../validations/platform.validation');

const router = express.Router();

// Every route here is staff-side. Students never reach it; tenant isolation lives in admin.service.

// Standard REST endpoints for staff / admin management (used by frontend /staff and /admins)
router.get('/', requireStaff, requirePermission('staff.view', 'VIEW_ADMINS'), adminController.getAdmins);
router.post('/', requireStaff, blockImpersonation, requirePermission('staff.create', 'CREATE_ADMIN'), upload.any(), validate(adminValidation.createStaff), adminController.createAdmin);

// Staff / Employee Routes (Legacy aliases)
router.post('/create-admin', requireStaff, blockImpersonation, requirePermission('staff.create', 'CREATE_ADMIN'), upload.any(), validate(adminValidation.createStaff), adminController.createAdmin);
router.get('/get-admins', requireStaff, requirePermission('staff.view', 'VIEW_ADMINS'), adminController.getAdmins);

// Library admin (platform level, superadmin only)
router.post('/create-library', requireSuperAdmin, upload.any(), validate(superCreateLibrary), adminController.createLibrary);
router.get('/get-libraries', requireSuperAdmin, adminController.getLibraries);
router.get('/dashboard', requireStaff, adminController.getDashboard);

// Shared Admin / Staff Management (tenant scoped in the service)
router.get('/get-admin', requireStaff, adminController.getAdminById); // own account
router.get('/get-admin/:id', requireStaff, validate(adminValidation.idParam), adminController.getAdminById);
router.put('/update-admin/:id', requireStaff, blockImpersonation, upload.any(), validate(adminValidation.updateStaff), adminController.updateAdmin);
router.put('/update-status/:id', requireStaff, blockImpersonation, validate(adminValidation.updateStatus), adminController.updateAdminStatus);
router.delete('/delete-admin/:id', requireStaff, blockImpersonation, validate(adminValidation.idParam), adminController.deleteAdmin);

// Owner, or staff whose role has "Reset Staff Password", sets a new password for a staff member
router.post('/reset-password/:id', requireStaff, blockImpersonation, requirePermission('staff.reset_password'), validate(adminValidation.resetStaffPassword), adminController.resetStaffPassword);

// Generic REST by id. MUST stay last: '/:id' would otherwise swallow /get-admins, /dashboard, /get-libraries, /get-admin ...
router.get('/:id', requireStaff, validate(adminValidation.idParam), adminController.getAdminById);
router.put('/:id', requireStaff, blockImpersonation, upload.any(), validate(adminValidation.updateStaff), adminController.updateAdmin);
router.delete('/:id', requireStaff, blockImpersonation, validate(adminValidation.idParam), adminController.deleteAdmin);

module.exports = router;
