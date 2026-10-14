const express = require('express');
const catchAsync = require('../../utils/catchAsync');
const validate = require('../../middlewares/validate.middleware');
const { requireSuperAdmin } = require('../../middlewares/access.middleware');
const { auditQuery } = require('../../validations/library.validation');
const auditService = require('../../services/audit.service');

const router = express.Router();

router.use(requireSuperAdmin);

// Platform-wide audit trail with filters: action, resource, userId, libraryId, from, to (YYYY-MM-DD in IST or ISO), page, limit
router.get('/', validate(auditQuery), catchAsync(async (req, res) => {
    const { data, pagination } = await auditService.queryLogs(req.query);
    res.json({ success: true, message: 'Audit logs retrieved successfully', data, pagination });
}));

module.exports = router;
