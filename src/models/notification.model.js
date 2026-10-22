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

// Every new notification, however it was created (events, broadcasts, system alerts), is also pushed to the
// recipient's subscribed browsers. Respects the push opt-out recorded on rows created through notifyEvent.
const wantsBrowserPush = (n) => {
    const d = n.deliveries || [];
    if (!d.length) return true;
    return d.some((x) => x.channel === 'push' && x.status !== 'opted_out');
};
const pushToBrowsers = (docs) => {
    try {
        const groups = new Map();
        (docs || []).filter(wantsBrowserPush).forEach((n) => {
            const url = n.data && typeof n.data.url === 'string' && n.data.url.startsWith('/') ? n.data.url : '/dashboard/notifications';
            const k = `${n.title}\u0000${n.message}\u0000${url}`;
            if (!groups.has(k)) groups.set(k, { title: n.title, body: n.message, url, type: n.type, list: [] });
            groups.get(k).list.push({ id: n.recipientId, type: n.recipientType });
        });
        if (!groups.size) return;
        const webPush = require('../services/webPush.service');
        groups.forEach((g) => {
            webPush.sendToRecipients(g.list, { title: g.title, body: g.body, url: g.url, data: { type: g.type } }).catch(() => {});
        });
    } catch (e) { console.error('Browser push hook failed:', e.message); }
};
notificationSchema.post('insertMany', (docs) => pushToBrowsers(docs));
notificationSchema.post('save', (doc) => pushToBrowsers([doc]));

module.exports = mongoose.model('Notification', notificationSchema);
