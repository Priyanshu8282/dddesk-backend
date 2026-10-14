const express = require('express');
const PlatformPlan = require('../../models/platformPlan.model');
const catchAsync = require('../../utils/catchAsync');

const router = express.Router();

const requireSA = (req, res, next) => {
    if (!req.user || req.user.userType !== 'superadmin') {
        return res.status(403).json({ success: false, message: 'Super Admin access required' });
    }
    next();
};

router.use(requireSA);

router.get('/', catchAsync(async (req, res) => {
    const plans = await PlatformPlan.find({ isDeleted: false }).sort({ monthlyPrice: 1 });
    res.json({ success: true, message: 'Platform plans retrieved successfully', data: plans });
}));

router.post('/', catchAsync(async (req, res) => {
    const { name, monthlyPrice, annualPrice, trialDays, graceDays, maxStudents, maxSeats, maxStaff, features, description } = req.body;
    if (!name || monthlyPrice === undefined) {
        return res.status(400).json({ success: false, message: 'Name and monthly price are required.' });
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const plan = await PlatformPlan.create({
        name, slug, description, monthlyPrice, annualPrice, trialDays, graceDays,
        maxStudents, maxSeats, maxStaff, features, createdBy: req.user._id
    });
    res.status(201).json({ success: true, message: 'Platform plan created successfully', data: plan });
}));

router.get('/:id', catchAsync(async (req, res) => {
    const plan = await PlatformPlan.findOne({ _id: req.params.id, isDeleted: false });
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });
    res.json({ success: true, message: 'Platform plan retrieved successfully', data: plan });
}));

router.put('/:id', catchAsync(async (req, res) => {
    const plan = await PlatformPlan.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { $set: req.body },
        { new: true, runValidators: true }
    );
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });
    res.json({ success: true, message: 'Platform plan updated.', data: plan });
}));

router.delete('/:id', catchAsync(async (req, res) => {
    const plan = await PlatformPlan.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { $set: { isDeleted: true } },
        { new: true }
    );
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found.' });
    res.json({ success: true, message: 'Platform plan archived.' });
}));

module.exports = router;
