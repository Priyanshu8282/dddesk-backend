const mongoose = require('mongoose');

// Shared counters for rate limiting. In serverless hosting every request may land on a different instance, so
// counting in process memory would let an attacker multiply their allowance. One document per limiter + client.
const rateLimitHitSchema = new mongoose.Schema({
    _id: { type: String },
    hits: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
}, { versionKey: false });

rateLimitHitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RateLimitHit', rateLimitHitSchema);
