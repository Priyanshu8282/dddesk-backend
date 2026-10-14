const express = require('express');
const permissionController = require('../../controllers/permission.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireSuperAdmin, requirePermission } = require('../../middlewares/access.middleware');
const v = require('../../validations/platform.validation');

const router = express.Router();

// Reading the permission catalogue (needed to build roles): owners, superadmin, staff who may view roles
router.get('/get-permissions', requireStaff, requirePermission('VIEW_PERMISSIONS', 'VIEW_ROLES'), permissionController.getPermissions);

// The catalogue itself is platform managed: superadmin only
router.post('/create-permission', requireSuperAdmin, validate(v.createPermission), permissionController.createPermission);
router.put('/update-permission/:id', requireSuperAdmin, validate(v.updatePermission), permissionController.updatePermission);
router.delete('/delete-permission/:id', requireSuperAdmin, validate(v.idParam), permissionController.deletePermission);

module.exports = router;
