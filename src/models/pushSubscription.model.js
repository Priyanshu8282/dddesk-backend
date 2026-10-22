const mongoose = require('mongoose');

// One row per browser/device that agreed to receive web push for a dashboard user.
const pushSubscriptionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'userType', index: true },
    userType: { type: String, required: true, enum: ['Admin', 'Student'] },
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library' },
    endpoint: { type: String, required: true, unique: true },
    keys: {
        p256dh: { type: String, required: true },
        auth: { type: String, required: true }
    },
    userAgent: { type: String, maxlength: 300 },
    lastSuccessAt: { type: Date },
    failures: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
