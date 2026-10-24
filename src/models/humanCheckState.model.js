const mongoose = require('mongoose');

// Short-lived human-check bookkeeping (TTL cleanup):
//   kind 'pow'  -> a proof-of-work challenge id that has been used (replay guard)
//   kind 'fail' -> failed sign-in counter for an identifier / IP (decides when the login needs a challenge)
const humanCheckStateSchema = new mongoose.Schema({
    kind: { type: String, enum: ['pow', 'fail'], required: true },
    key: { type: String, required: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
}, { timestamps: false });

humanCheckStateSchema.index({ kind: 1, key: 1 }, { unique: true });
humanCheckStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.HumanCheckState || mongoose.model('HumanCheckState', humanCheckStateSchema);
