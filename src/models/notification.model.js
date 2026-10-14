const mongoose = require('mongoose');

const deliverySchema = new mongoose.Schema({
    channel: { type: String, enum: ['inapp', 'push', 'email', 'sms', 'whatsapp'], required: true },
    status: {
        type: String,
        enum: ['sent', 'failed', 'skipped', 'not_configured', 'no_tokens', 'opted_out'],
        required: true
    },
    error: { type: String }
}, { _id: false });

const notificationSchema = new mongoose.Schema({
    recipientId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        refPath: 'recipientType'
    },
    recipientType: {
        type: String,
        required: true,
        enum: ['Admin', 'Student']
    },
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        index: true
    },
    type: {
        type: String,
        required: true,
        default: 'system_alert'
    },
    // Event key when created through notifyEvent (approval, fee-due, ...)
    event: { type: String },
    title: {
        type: String,
        required: true
    },
    message: {
        type: String,
        required: true
    },
    isRead: {
        type: Boolean,
        default: false
    },
    readAt: { type: Date },
    data: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    deliveries: [deliverySchema]
}, { timestamps: true });

notificationSchema.index({ recipientId: 1, recipientType: 1, createdAt: -1 });
notificationSchema.index({ recipientId: 1, recipientType: 1, isRead: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
