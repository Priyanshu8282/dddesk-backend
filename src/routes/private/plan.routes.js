const express = require('express');
const planController = require('../../controllers/plan.controller');
const validate = require('../../middlewares/validate.middleware');
const { planValidation } = require('../../validations');

const router = express.Router();

router.post('/create-plan', validate(planValidation.createPlan), planController.createPlan);
router.post('/', validate(planValidation.createPlan), planController.createPlan);

router.get('/get-plans', planController.getPlans);
router.get('/', planController.getPlans);

router.get('/get-plan/:id', planController.getPlan);
router.get('/:id', planController.getPlan);

router.put('/update-plan/:id', planController.updatePlan);
router.put('/:id', planController.updatePlan);

router.delete('/delete-plan/:id', planController.deletePlan);
router.delete('/:id', planController.deletePlan);

module.exports = router;
