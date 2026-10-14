const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/branch.controller');
const validate = require('../../middlewares/validate.middleware');
const { branchValidation } = require('../../validations');

router.get('/',         ctrl.getBranches);
router.post('/',        validate(branchValidation.createBranch), ctrl.createBranch);
router.get('/:id',      ctrl.getBranchById);
router.put('/:id',      ctrl.updateBranch);
router.delete('/:id',   ctrl.deleteBranch);
router.patch('/:id/set-main', ctrl.setMainBranch);

module.exports = router;
