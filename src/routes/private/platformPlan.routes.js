const express = require('express');
const catchAsync = require('../../utils/catchAsync');
const validate = require('../../middlewares/validate.middleware');
const { requireSuperAdmin } = require('../../middlewares/access.middleware');
const v = require('../../validations/platform.validation');
const svc = require('../../services/platformPlan.service');

const router = express.Router();

router.use(requireSuperAdmin);

router.get('/', catchAsync(async (req, res) => {
    const plans = await svc.list();
    res.json({ success: true, message: 'Platform plans retrieved successfully', data: plans });
}));

router.post('/', validate(v.createPlatformPlan), catchAsync(async (req, res) => {
    const plan = await svc.create(req);
    res.status(201).json({ success: true, message: 'Platform plan created successfully', data: plan });
}));

router.get('/:id', validate(v.idParam), catchAsync(async (req, res) => {
    const plan = await svc.get(req.params.id);
    res.json({ success: true, message: 'Platform plan retrieved successfully', data: plan });
}));

// Allow-listed update; limit changes propagate to the libraries on this plan
router.put('/:id', validate(v.updatePlatformPlan), catchAsync(async (req, res) => {
    const { plan, propagated } = await svc.update(req, req.params.id);
    res.json({ success: true, message: 'Platform plan updated.', data: plan, librariesUpdated: propagated });
}));

router.delete('/:id', validate(v.idParam), catchAsync(async (req, res) => {
    await svc.archive(req, req.params.id);
    res.json({ success: true, message: 'Platform plan archived.' });
}));

module.exports = router;
