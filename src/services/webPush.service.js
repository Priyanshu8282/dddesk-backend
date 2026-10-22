const webpush = require('web-push');
const PushSubscription = require('../models/pushSubscription.model');
const WebPushConfig = require('../models/webPushConfig.model');

// Browser push (works with the browser minimised or the tab closed, as long as the browser itself is running;
// on phones the OS wakes it). Mobile apps keep using FCM (see firebase.service.js).

let ready = null; // memoised promise: { publicKey }

const subject = () => process.env.VAPID_SUBJECT || `mailto:${process.env.SUPPORT_EMAIL || 'support@dddesk.ai'}`;

const loadKeys = async () => {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    }
    let doc = await WebPushConfig.findOne({ key: 'default' }).select('+privateKey');
    if (!doc) {
        const k = webpush.generateVAPIDKeys();
        try {
            doc = await WebPushConfig.create({ key: 'default', publicKey: k.publicKey, privateKey: k.privateKey });
        } catch (e) { // another instance created it first
            doc = await WebPushConfig.findOne({ key: 'default' }).select('+privateKey');
        }
    }
    return { publicKey: doc.publicKey, privateKey: doc.privateKey };
};

const init = () => {
    if (!ready) {
        ready = loadKeys().then((k) => {
            webpush.setVapidDetails(subject(), k.publicKey, k.privateKey);
            return { publicKey: k.publicKey };
        }).catch((e) => { ready = null; throw e; });
    }
    return ready;
};

const getPublicKey = async () => (await init()).publicKey;

const subscribe = async ({ userId, userType, libraryId, subscription, userAgent }) => {
    const { endpoint, keys } = subscription || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
        const err = new Error('Invalid push subscription'); err.statusCode = 400; throw err;
    }
    // The same browser can be re-used by another login: the endpoint always belongs to the latest user
    await PushSubscription.findOneAndUpdate(
        { endpoint },
        { $set: { userId, userType, libraryId, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: String(userAgent || '').slice(0, 300), failures: 0 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

const unsubscribe = async ({ userId, endpoint }) => {
    if (!endpoint) return 0;
    const r = await PushSubscription.deleteOne({ endpoint, userId });
    return r.deletedCount;
};

const count = (userId, userType) => PushSubscription.countDocuments({ userId, userType });

/**
 * Send one message to every browser a set of users has subscribed.
 * recipients: [{ id, type }]  payload: { title, body, url?, tag?, data? }
 * Never throws. Dead subscriptions (404/410) are removed.
 */
const sendToRecipients = async (recipients, payload) => {
    const out = { sent: 0, failed: 0, removed: 0 };
    try {
        if (!recipients || !recipients.length) return out;
        await init();
        const byType = {};
        recipients.forEach((r) => { (byType[r.type] = byType[r.type] || []).push(r.id); });
        const subs = await PushSubscription.find({ $or: Object.entries(byType).map(([userType, ids]) => ({ userType, userId: { $in: ids } })) }).lean();
        if (!subs.length) return out;
        const body = JSON.stringify({
            title: payload.title,
            body: payload.body,
            url: payload.url || '/dashboard/notifications',
            tag: payload.tag,
            data: payload.data || {},
            at: Date.now()
        });
        const dead = [];
        await Promise.all(subs.map(async (s) => {
            try {
                await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 60 * 60 * 24, urgency: 'high' });
                out.sent += 1;
                PushSubscription.updateOne({ _id: s._id }, { $set: { lastSuccessAt: new Date(), failures: 0 } }).catch(() => {});
            } catch (e) {
                out.failed += 1;
                if (e.statusCode === 404 || e.statusCode === 410) dead.push(s._id);
                else PushSubscription.updateOne({ _id: s._id }, { $inc: { failures: 1 } }).catch(() => {});
            }
        }));
        if (dead.length) {
            await PushSubscription.deleteMany({ _id: { $in: dead } });
            out.removed = dead.length;
        }
    } catch (e) {
        console.error('Web push failed:', e.message);
    }
    return out;
};

module.exports = { getPublicKey, subscribe, unsubscribe, count, sendToRecipients, init };
