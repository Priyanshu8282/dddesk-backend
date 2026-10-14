const express = require('express');
const ctrl = require('../../controllers/library.controller');
const multerUpload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireOwner, requireSuperAdmin, requirePermission } = require('../../middlewares/access.middleware');
const libraryValidation = require('../../validations/library.validation');
const v = require('../../validations/platform.validation');

const router = express.Router();

// ---- Library owner / staff (own tenant; students never reach these) ----

// Profile & settings (spec section 7)
router.get('/profile', requireStaff, ctrl.getProfile);
router.put('/profile', requireStaff, requirePermission('settings.manage', 'UPDATE_LIBRARY'),
    multerUpload.any(), validate(libraryValidation.updateProfile), ctrl.updateProfile);

// Own account password (current password required)
router.patch('/change-password', requireStaff, validate(libraryValidation.changePassword), ctrl.changePassword);

// Subscription state (trial / active / grace / expired) and usage vs plan limits
router.get('/my-plan', requireStaff, ctrl.getMyPlan);

// Owner audit trail for their own library
router.get('/audit-logs', requireOwner, validate(libraryValidation.auditQuery), ctrl.getAuditLogs);

// ---- Platform level library management (superadmin only) ----
router.get('/all', requireSuperAdmin, ctrl.getAllLibraries);
router.patch('/status/:id', requireSuperAdmin, validate(v.idParam), ctrl.updateLibraryStatus);
router.get('/:id', requireSuperAdmin, validate(v.idParam), ctrl.getLibraryById);
router.put('/:id', requireSuperAdmin, validate(v.superUpdateLibrary), ctrl.updateLibrary);
router.delete('/:id', requireSuperAdmin, validate(v.idParam), ctrl.deleteLibrary);

module.exports = router;
