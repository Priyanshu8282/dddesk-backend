const express = require('express');
const ctrl = require('../../controllers/onboarding.controller');
const validate = require('../../middlewares/validate.middleware');
const v = require('../../validations/onboarding.validation');

const router = express.Router();

// Any signed-in staff/owner/superadmin (students have no tour)
router.patch('/profile/tour', validate(v.tourPatch), ctrl.updateTour);

// Library owner / staff dashboard checklist
router.get('/onboarding/checklist', ctrl.checklist);

module.exports = router;
