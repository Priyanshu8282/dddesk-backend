const AuditLog = require('../models/auditLog.model');
const { describeRequest } = require('./device');

// Fire-and-forget audit trail. Never throws into the caller.
// audit(req, 'payment.collect', 'Payment', payment._id, { amount })
const audit = async (req, action, resource, resourceId = null, metadata = {}) => {
    try {
        await AuditLog.create({
            action, resource, resourceId,
            libraryId: req.libraryId || null,
            userId: req.user?._id,
            userType: req.userType || 'system',
            metadata: req.impersonatedBy ? { ...metadata, impersonatedBy: req.impersonatedBy } : metadata,
            ipAddress: describeRequest(req).ip,
            userAgent: describeRequest(req).userAgent,
            device: describeRequest(req).device,
        });
    } catch (e) {
        console.error('Audit log failed:', e.message);
    }
};

module.exports = audit;
