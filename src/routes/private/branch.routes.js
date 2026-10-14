const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/branch.controller');
const validate = require('../../middlewares/validate.middleware');
const { branchValidation } = require('../../validations');
const v = require('../../validations/platform.validation');
const { requireStaff, requireOwner, requirePermission } = require('../../middlewares/access.middleware');

// Reading: any staff of the library. Structural changes (create / delete / set main): owner only.
router.get('/',         requireStaff, ctrl.getBranches);
router.post('/',        requireOwner, validate(branchValidation.createBranch), ctrl.createBranch);
router.get('/:id',      requireStaff, validate(v.idParam), ctrl.getBranchById);
router.put('/:id',      requireStaff, requirePermission('branches.manage', 'settings.manage'), validate(v.updateBranch), ctrl.updateBranch);
router.delete('/:id',   requireOwner, validate(v.idParam), ctrl.deleteBranch);
router.patch('/:id/set-main', requireOwner, validate(v.idParam), ctrl.setMainBranch);

module.exports = router;
