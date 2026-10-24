const mongoose = require('mongoose');

// One document per signed-in device/browser. The access JWT carries this id (`sid`); revoking the document ends the
// session within a few seconds. The refresh token is stored only as a SHA-256 hash and is rotated on every use.
const sessionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    userType: { type: String, enum: ['superadmin', 'admin', 'staff', 'student'], required: true },
    libraryId: { type: mongoose.Schema.Types.ObjectId, default: null },
    refreshHash: { type: String, default: null },       // current refresh token (hash); null for support (impersonation) sessions
    prevRefreshHash: { type: String, default: null },   // previous token, kept briefly to tell a parallel tab from a stolen token
    rotatedAt: { type: Date, default: null },
    impersonatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    persistent: { type: Boolean, default: true },        // "remember me": cookie survives browser restarts
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    device: { type: String, default: null },             // short human summary, e.g. "Chrome on Windows"
    lastUsedAt: { type: Date, default: Date.now },
    absoluteExpiresAt: { type: Date, required: true },   // hard cap, never extended
    expiresAt: { type: Date, required: true },           // idle expiry, extended on refresh (TTL index below)
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

sessionSchema.index({ userId: 1, userType: 1, revokedAt: 1 });
// expired sessions disappear on their own
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Session', sessionSchema);
