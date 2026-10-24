const express = require('express');
const ctrl = require('../../controllers/superLibrary.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireSuperAdmin } = require('../../middlewares/access.middleware');
const v = require('../../validations/platform.validation');
const upload = require('../../middlewares/upload.middleware');

const router = express.Router();

// Everything here is platform level
router.use(requireSuperAdmin);

router.get('/', ctrl.getAllLibraries);
// owner photo arrives as multipart (field: profileImage); plain JSON still works
router.post('/', upload.single('profileImage'), validate(v.superCreateLibrary), ctrl.createLibrary);
router.get('/:id', validate(v.idParam), ctrl.getLibraryById);
router.put('/:id', upload.single('profileImage'), validate(v.superUpdateLibrary), ctrl.updateLibrary);
router.delete('/:id', validate(v.idParam), ctrl.deleteLibrary);

// Library lifecycle - the only way library status changes
router.patch('/:id/approve', validate(v.idParam), ctrl.approveLibrary);
router.patch('/:id/reject', validate(v.rejectOrSuspend), ctrl.rejectLibrary);
router.patch('/:id/suspend', validate(v.rejectOrSuspend), ctrl.suspendLibrary);
router.patch('/:id/reinstate', validate(v.idParam), ctrl.reinstateLibrary);

// Subscription
router.get('/:id/plan', validate(v.idParam), ctrl.getLibraryPlan);
router.patch('/:id/plan', validate(v.assignPlan), ctrl.assignPlan);

// Audited support access: short-lived token as the library owner
router.post('/:id/impersonate', validate(v.idParam), ctrl.impersonate);

module.exports = router;
