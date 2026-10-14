const express = require('express');
const planController = require('../../controllers/plan.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requirePermission } = require('../../middlewares/access.middleware');
const { planValidation } = require('../../validations');

const router = express.Router();

// Legacy keys + catalog keys: plans are operational settings; anyone who admits students may read them
const VIEW = ['VIEW_PLANS', 'CREATE_STUDENT', 'UPDATE_STUDENT', 'students.view', 'students.create', 'students.edit', 'settings.manage'];
const CREATE = ['CREATE_PLAN', 'settings.manage'];
const EDIT = ['UPDATE_PLAN', 'settings.manage'];
const DELETE = ['DELETE_PLAN', 'settings.manage'];

// Plans are managed by library staff only (students never reach these routes)
router.use(requireStaff);

router.post('/create-plan', requirePermission(...CREATE), validate(planValidation.createPlan), planController.createPlan);
router.post('/', requirePermission(...CREATE), validate(planValidation.createPlan), planController.createPlan);

router.get('/get-plans', requirePermission(...VIEW), validate(planValidation.listPlans), planController.getPlans);
router.get('/', requirePermission(...VIEW), validate(planValidation.listPlans), planController.getPlans);

router.get('/get-plan/:id', requirePermission(...VIEW), planController.getPlan);

router.put('/update-plan/:id', requirePermission(...EDIT), validate(planValidation.updatePlan), planController.updatePlan);
router.patch('/:id/status', requirePermission(...EDIT), validate(planValidation.updatePlanStatus), planController.updatePlanStatus);

router.delete('/delete-plan/:id', requirePermission(...DELETE), planController.deletePlan);

router.get('/:id', requirePermission(...VIEW), planController.getPlan);
router.put('/:id', requirePermission(...EDIT), validate(planValidation.updatePlan), planController.updatePlan);
router.delete('/:id', requirePermission(...DELETE), planController.deletePlan);

module.exports = router;
