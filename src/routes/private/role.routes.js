const express = require('express');
const roleController = require('../../controllers/role.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireOwner, requirePermission } = require('../../middlewares/access.middleware');
const v = require('../../validations/platform.validation');

const router = express.Router();

// Reading roles: owners, superadmin, and staff holding a role permission (needed for staff forms)
router.get('/get-roles', requireStaff, requirePermission('VIEW_ROLES', 'staff.view', 'staff.create', 'staff.edit'), roleController.getRoles);
router.get('/get-role/:id', requireStaff, requirePermission('VIEW_ROLES', 'staff.view', 'staff.create', 'staff.edit'), validate(v.idParam), roleController.getRoleById);

// Writing roles: library owner (own tenant) or superadmin only
router.post('/create-role', requireOwner, validate(v.createRole), roleController.createRole);
router.post('/duplicate-role/:id', requireOwner, validate(v.idParam), roleController.duplicateRole);
router.put('/update-role/:id', requireOwner, validate(v.updateRole), roleController.updateRole);
router.patch('/update-status/:id', requireOwner, validate(v.setRoleStatus), roleController.setRoleStatus);
router.delete('/delete-role/:id', requireOwner, validate(v.idParam), roleController.deleteRole);

module.exports = router;
