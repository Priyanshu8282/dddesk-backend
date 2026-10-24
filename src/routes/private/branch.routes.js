const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/branch.controller');
const validate = require('../../middlewares/validate.middleware');
const { branchValidation } = require('../../validations');
const v = require('../../validations/platform.validation');
const { requireStaff, requireOwner, requirePermission } = require('../../middlewares/access.middleware');
const { assertBranchAccess } = require('../../utils/branchScope');

// Branch-limited staff may only reach the branches they are assigned to
router.param('id', (req, res, next, id) => {
    try { if (req.userType === 'staff') assertBranchAccess(req, id); next(); } catch (e) { next(e); }
});

// Reading: any staff of the library. Structural changes (create / delete / set main): owner only.
router.get('/',         requireStaff, ctrl.getBranches);
router.post('/',        requireOwner, validate(branchValidation.createBranch), ctrl.createBranch);
router.get('/:id',      requireStaff, validate(v.idParam), ctrl.getBranchById);
router.put('/:id',      requireStaff, requirePermission('branches.manage', 'settings.manage'), validate(v.updateBranch), ctrl.updateBranch);
router.patch('/:id/status', requireStaff, requirePermission('branches.manage', 'settings.manage'), validate(branchValidation.setBranchStatus), ctrl.setBranchStatus);
router.delete('/:id',   requireOwner, validate(v.idParam), ctrl.deleteBranch);
router.patch('/:id/set-main', requireOwner, validate(v.idParam), ctrl.setMainBranch);

module.exports = router;
