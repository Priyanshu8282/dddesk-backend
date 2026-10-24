const RateLimitHit = require('../models/rateLimitHit.model');

/**
 * express-rate-limit store backed by MongoDB, so limits hold across serverless instances.
 * One atomic upsert per request: it either bumps the counter of the live window or starts a new window.
 */
class MongoRateLimitStore {
    constructor(prefix) {
        this.prefix = prefix;
        this.localKeys = false; // counters live outside this process
    }

    init(options) {
        this.windowMs = options.windowMs;
    }

    key(k) {
        return `${this.prefix}:${k}`.slice(0, 300);
    }

    async increment(k) {
        const now = new Date();
        const fresh = new Date(now.getTime() + this.windowMs);
        const doc = await RateLimitHit.findOneAndUpdate(
            { _id: this.key(k) },
            [{
                $set: {
                    hits: { $cond: [{ $gt: [{ $ifNull: ['$expiresAt', new Date(0)] }, now] }, { $add: [{ $ifNull: ['$hits', 0] }, 1] }, 1] },
                    expiresAt: { $cond: [{ $gt: [{ $ifNull: ['$expiresAt', new Date(0)] }, now] }, '$expiresAt', fresh] },
                },
            }],
            { upsert: true, new: true }
        );
        return { totalHits: doc.hits, resetTime: doc.expiresAt };
    }

    async decrement(k) {
        await RateLimitHit.updateOne({ _id: this.key(k), hits: { $gt: 0 } }, { $inc: { hits: -1 } });
    }

    async resetKey(k) {
        await RateLimitHit.deleteOne({ _id: this.key(k) });
    }
}

module.exports = MongoRateLimitStore;
