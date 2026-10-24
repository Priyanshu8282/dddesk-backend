const mongoose = require('mongoose');

// Security-relevant events, including ones with no known user (failed sign-ins on unknown accounts,
// rate-limit blocks). Separate from AuditLog, which records what known users DID.
const RETENTION_DAYS = Number(process.env.SECURITY_LOG_RETENTION_DAYS || 365);

const securityEventSchema = new mongoose.Schema({
    type: {
        type: String, required: true,
        enum: ['login', 'otp_request', 'otp_verify', 'password_reset_request', 'password_reset', 'password_change', 'rate_limited', 'forbidden', 'tenant_mismatch', 'account_blocked', 'logout', 'session_refresh', 'session_revoked', 'impersonation', 'role_change', 'refund', 'maintenance'],
    },
    outcome: { type: String, required: true, enum: ['success', 'failure', 'blocked'] },
    reason: { type: String, default: null },       // invalid_credentials | invalid_otp | otp_locked | account_disabled | library_blocked | ...
    identifier: { type: String, default: null },   // what was typed, partly masked (never a password or OTP)
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    userType: { type: String, default: null },
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', default: null },
    ip: { type: String, default: 'unknown' },
    userAgent: { type: String, default: null },
    device: { type: mongoose.Schema.Types.Mixed, default: null }, // parsed: browser, os, deviceType, model, summary
    method: { type: String, default: null },
    path: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: true, updatedAt: false } });

securityEventSchema.index({ type: 1, outcome: 1, createdAt: -1 });
securityEventSchema.index({ ip: 1, createdAt: -1 });
securityEventSchema.index({ libraryId: 1, createdAt: -1 });
// old events expire on their own (this index also serves "newest first" queries)
securityEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: Math.round(RETENTION_DAYS * 86400), name: 'ttl_retention' });

module.exports = mongoose.model('SecurityEvent', securityEventSchema);
module.exports.RETENTION_DAYS = RETENTION_DAYS;
