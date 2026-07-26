const express = require('express');
const Authentication = require('../../middlewares/auth.middleware');
const planController = require('./plan.controller');

const router = express.Router();

router.use(Authentication);

router
    .route('/')
    .post(planController.createPlan)
    .get(planController.getPlans);

router
    .route('/:planId')
    .get(planController.getPlan)
    .put(planController.updatePlan)
    .delete(planController.deletePlan);

router.patch('/status/:planId', planController.updatePlanStatus);

module.exports = router;
