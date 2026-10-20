const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
    action: { type: String, required: true, index: true },
    resource: { type: String, required: true },
    resourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', default: null, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    userType: { type: String, enum: ['superadmin', 'admin', 'staff', 'student', 'system'], required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: 'unknown' },
    userAgent: { type: String, default: null },   // raw browser string (trimmed)
    device: { type: mongoose.Schema.Types.Mixed, default: null } // parsed: browser, os, deviceType, model, summary
}, { timestamps: true });

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ resource: 1, resourceId: 1 });
auditLogSchema.index({ libraryId: 1, createdAt: -1 });
auditLogSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
