const express = require('express');
const catchAsync = require('../../utils/catchAsync');
const PlatformPlan = require('./platformPlan.model');
const Authentication = require('../../middlewares/auth.middleware');
const AuditLog = require('../audit/auditLog.model');

const router = express.Router();

const requireSA = (req, res, next) => {
    if (!req.user || req.user.userType !== 'superadmin') {
        return res.status(403).json({ success: false, message: 'Super Admin access required' });
    }
    next();
};

router.use(Authentication, requireSA);

// GET all platform plans
router.get('/', catchAsync(async (req, res) => {
    const plans = await PlatformPlan.find({ isDeleted: false }).sort({ monthlyPrice: 1 });
    res.json({ success: true, data: plans });
}));

// POST create plan
router.post('/', catchAsync(async (req, res) => {
    const { name, description, monthlyPrice, annualPrice, trialDays, graceDays, maxStudents, maxSeats, maxStaff, features, isActive } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Plan name is required' });

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    const exists = await PlatformPlan.findOne({ slug, isDeleted: false });
    if (exists) return res.status(400).json({ success: false, message: 'A plan with this name already exists' });

    const plan = await PlatformPlan.create({ name, slug, description, monthlyPrice, annualPrice, trialDays, graceDays, maxStudents, maxSeats, maxStaff, features, isActive, createdBy: req.user._id });
    await AuditLog.create({ action: 'platform_plan_created', resource: 'PlatformPlan', resourceId: plan._id, userId: req.user._id, userType: 'superadmin', metadata: { name }, ipAddress: req.ip });
    res.status(201).json({ success: true, message: 'Plan created', data: plan });
}));

// PUT update plan
router.put('/:id', catchAsync(async (req, res) => {
    const plan = await PlatformPlan.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, req.body, { new: true, runValidators: true });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    await AuditLog.create({ action: 'platform_plan_updated', resource: 'PlatformPlan', resourceId: plan._id, userId: req.user._id, userType: 'superadmin', metadata: { name: plan.name }, ipAddress: req.ip });
    res.json({ success: true, message: 'Plan updated', data: plan });
}));

// DELETE (soft) plan
router.delete('/:id', catchAsync(async (req, res) => {
    const plan = await PlatformPlan.findOneAndUpdate({ _id: req.params.id, isDeleted: false }, { isDeleted: true }, { new: true });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    await AuditLog.create({ action: 'platform_plan_deleted', resource: 'PlatformPlan', resourceId: plan._id, userId: req.user._id, userType: 'superadmin', metadata: { name: plan.name }, ipAddress: req.ip });
    res.json({ success: true, message: 'Plan deleted' });
}));

module.exports = router;
