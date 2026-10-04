const express = require('express');
const router = express.Router();
const ctrl = require('./branch.controller');
const Authentication = require('../../middlewares/auth.middleware');

router.get('/',         Authentication, ctrl.getBranches);
router.get('/:id',      Authentication, ctrl.getBranchById);
router.post('/',        Authentication, ctrl.createBranch);
router.put('/:id',      Authentication, ctrl.updateBranch);
router.delete('/:id',   Authentication, ctrl.deleteBranch);
router.patch('/:id/set-main', Authentication, ctrl.setMainBranch);

module.exports = router;
