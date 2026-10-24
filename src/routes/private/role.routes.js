const express = require('express');
const roleController = require('../../controllers/role.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireOwner, requirePermission, blockImpersonation } = require('../../middlewares/access.middleware');
const v = require('../../validations/platform.validation');

const router = express.Router();

// Reading roles: owners, superadmin, and staff holding a role permission (needed for staff forms)
router.get('/get-roles', requireStaff, requirePermission('VIEW_ROLES', 'staff.view', 'staff.create', 'staff.edit'), roleController.getRoles);
router.get('/get-role/:id', requireStaff, requirePermission('VIEW_ROLES', 'staff.view', 'staff.create', 'staff.edit'), validate(v.idParam), roleController.getRoleById);

// Writing roles: library owner (own tenant) or superadmin only
router.post('/create-role', requireOwner, blockImpersonation, validate(v.createRole), roleController.createRole);
router.post('/duplicate-role/:id', requireOwner, blockImpersonation, validate(v.idParam), roleController.duplicateRole);
router.put('/update-role/:id', requireOwner, blockImpersonation, validate(v.updateRole), roleController.updateRole);
router.patch('/update-status/:id', requireOwner, blockImpersonation, validate(v.setRoleStatus), roleController.setRoleStatus);
router.delete('/delete-role/:id', requireOwner, blockImpersonation, validate(v.idParam), roleController.deleteRole);

module.exports = router;
