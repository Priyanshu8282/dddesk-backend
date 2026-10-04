const express = require('express');
const ctrl = require('./superLibrary.controller');
const Authentication = require('../../middlewares/auth.middleware');

const router = express.Router();

// All SA library routes require authentication + superadmin check
const requireSA = (req, res, next) => {
    if (!req.user || req.user.userType !== 'superadmin') {
        return res.status(403).json({ success: false, message: 'Super Admin access required' });
    }
    next();
};

router.use(Authentication, requireSA);

router.get('/',    ctrl.getAllLibraries);
router.post('/',   ctrl.createLibrary);
router.get('/:id', ctrl.getLibraryById);
router.put('/:id', ctrl.updateLibrary);
router.delete('/:id', ctrl.deleteLibrary);
router.patch('/:id/approve',   ctrl.approveLibrary);
router.patch('/:id/reject',    ctrl.rejectLibrary);
router.patch('/:id/suspend',   ctrl.suspendLibrary);
router.patch('/:id/reinstate', ctrl.reinstateLibrary);
router.get('/:id/plan',    ctrl.getLibraryPlan);
router.patch('/:id/plan',  ctrl.assignPlan);

module.exports = router;
