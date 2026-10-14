const mongoose = require('mongoose');

// Idempotency log for payment-gateway webhooks (unique event id)
const webhookEventSchema = new mongoose.Schema({
    eventId: { type: String, required: true, unique: true },
    event: { type: String },
    processedAt: { type: Date, default: Date.now },
    // set by the handler when processing is rejected/failed (shown on the super admin system-events page)
    status: { type: String, enum: ['processed', 'failed'], default: 'processed' },
    error: { type: String }
}, { timestamps: true });

webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
