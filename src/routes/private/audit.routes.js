const express = require('express');
const AuditLog = require('../../models/auditLog.model');
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
    const { action, resource, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (action) filter.action = action;
    if (resource) filter.resource = resource;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [logs, total] = await Promise.all([
        AuditLog.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .populate('userId', 'name email userType'),
        AuditLog.countDocuments(filter),
    ]);

    res.json({
        success: true,
        message: 'Audit logs retrieved successfully',
        data: logs,
        pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
}));

module.exports = router;
