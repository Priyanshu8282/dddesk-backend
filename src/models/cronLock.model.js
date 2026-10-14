const mongoose = require('mongoose');

// Simple distributed lock so a cron job does not run twice (multi-instance / restarts)
const cronLockSchema = new mongoose.Schema({
    _id: { type: String },
    lockedUntil: { type: Date, required: true },
    owner: { type: String }
}, { versionKey: false });

cronLockSchema.statics.acquire = async function (key, ttlMs, owner = String(process.pid)) {
    const now = new Date();
    try {
        const doc = await this.findOneAndUpdate(
            { _id: key, lockedUntil: { $lte: now } },
            { $set: { lockedUntil: new Date(now.getTime() + ttlMs), owner } },
            { returnDocument: 'after' }
        );
        if (doc) return true;
        // No expired lock: create one if none exists (duplicate key => someone else holds it)
        await this.create({ _id: key, lockedUntil: new Date(now.getTime() + ttlMs), owner });
        return true;
    } catch (e) {
        if (e && e.code === 11000) return false;
        throw e;
    }
};

cronLockSchema.statics.release = async function (key, owner = String(process.pid)) {
    await this.updateOne({ _id: key, owner }, { $set: { lockedUntil: new Date(0) } });
};

module.exports = mongoose.models.CronLock || mongoose.model('CronLock', cronLockSchema);
