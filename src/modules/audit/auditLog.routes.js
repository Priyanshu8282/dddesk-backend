const express = require('express');
const catchAsync = require('../../utils/catchAsync');
const AuditLog = require('./auditLog.model');
const Authentication = require('../../middlewares/auth.middleware');

const router = express.Router();

const requireSA = (req, res, next) => {
    if (!req.user || req.user.userType !== 'superadmin') {
        return res.status(403).json({ success: false, message: 'Super Admin access required' });
    }
    next();
};

router.use(Authentication, requireSA);

router.get('/', catchAsync(async (req, res) => {
    const { action, resource, page = 1, limit = 30 } = req.query;
    const query = {};
    if (action) query.action = action;
    if (resource) query.resource = resource;

    const skip = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
        AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).populate('userId', 'name email userType'),
        AuditLog.countDocuments(query)
    ]);

    res.json({
        success: true,
        data: { logs, pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) } }
    });
}));

module.exports = router;
