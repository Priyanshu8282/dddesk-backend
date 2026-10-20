const mongoose = require('mongoose');
const Notification = require('../models/notification.model');
const ApiError = require('../utils/ApiError');

// ─── Inbox (per user) ────────────────────────────────────────────────────────
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Filters: status (all|unread|read), type, search (title/message), from/to (YYYY-MM-DD, IST days), sort (newest|oldest)
const getNotifications = async (userId, userType, query = {}) => {
    const { page = 1, limit = 50, status, type, search, from, to, sort } = query;
    const p = Math.max(parseInt(page, 10) || 1, 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    const base = { recipientId: userId, recipientType: userType };
    const filter = { ...base };
    if (status === 'unread') filter.isRead = false;
    else if (status === 'read') filter.isRead = true;
    if (type) filter.type = String(type);
    const q = String(search || '').trim().slice(0, 80);
    if (q) {
        const re = new RegExp(escapeRe(q), 'i');
        filter.$or = [{ title: re }, { message: re }];
    }
    const range = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(from || ''))) range.$gte = new Date(`${from}T00:00:00+05:30`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) range.$lte = new Date(`${to}T23:59:59.999+05:30`);
    if (range.$gte || range.$lte) filter.createdAt = range;

    const now = new Date();
    const istDay = new Date(now.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    const todayStart = new Date(`${istDay}T00:00:00+05:30`);
    const [notifications, unreadCount, total, all, today, types] = await Promise.all([
        Notification.find(filter).sort({ createdAt: sort === 'oldest' ? 1 : -1, _id: -1 }).skip((p - 1) * l).limit(l).lean(),
        Notification.countDocuments({ ...base, isRead: false }),
        Notification.countDocuments(filter),
        Notification.countDocuments(base),
        Notification.countDocuments({ ...base, createdAt: { $gte: todayStart } }),
        Notification.aggregate([
            { $match: base },
            { $group: { _id: '$type', count: { $sum: 1 }, unread: { $sum: { $cond: ['$isRead', 0, 1] } } } },
            { $sort: { count: -1 } }
        ])
    ]);
    return {
        notifications, unreadCount, total, page: p, totalPages: Math.ceil(total / l),
        stats: { all, unread: unreadCount, read: all - unreadCount, today },
        types: types.map((t) => ({ type: t._id, count: t.count, unread: t.unread }))
    };
};

// Owner/staff broadcast to their students (in-app + push, optional email/sms/whatsapp via library prefs)
const AUDIENCES = ['all', 'active', 'expiring', 'expired', 'pending'];
const resolveStudentIds = async (libraryId, audience) => {
    const Student = require('../models/student.model');
    const filter = { libraryId, isDeleted: false };
    if (audience === 'active') Object.assign(filter, { status: 'active', planStatus: 'active' });
    else if (audience === 'expired') filter.planStatus = 'expired';
    else if (audience === 'pending') filter.planStatus = 'pending';
    else if (audience === 'expiring') {
        const now = new Date();
        Object.assign(filter, { planStatus: 'active', expiryDate: { $gte: now, $lte: new Date(now.getTime() + 7 * 86400000) } });
    } else filter.status = 'active';
    const rows = await Student.find(filter).select('_id').lean();
    return rows.map((r) => r._id);
};

const broadcastToStudents = async (libraryId, { audience = 'all', title, message, channels }) => {
    if (!AUDIENCES.includes(audience)) throw new ApiError(400, 'Unknown audience');
    const ids = await resolveStudentIds(libraryId, audience);
    if (!ids.length) throw new ApiError(400, 'No students match this audience');
    const res = await notifyEvent('announcement', libraryId, {
        studentIds: ids, title, message, channels: channels && channels.length ? channels : ['inapp', 'push'],
        variables: { title, message }, data: { type: 'announcement', source: 'owner' }
    });
    if (res.error) throw new ApiError(500, res.error);
    return { recipients: res.recipients, audience };
};

const markAllAsRead = async (userId, userType) => {
    await Notification.updateMany(
        { recipientId: userId, recipientType: userType, isRead: false },
        { $set: { isRead: true, readAt: new Date() } }
    );
};

const markOneAsRead = async (id, userId, userType) => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid notification ID');
    const n = await Notification.findOneAndUpdate(
        { _id: id, recipientId: userId, recipientType: userType },
        { $set: { isRead: true, readAt: new Date() } },
        { new: true }
    );
    if (!n) throw new ApiError(404, 'Notification not found');
    return n;
};

const deleteNotifications = async (userId, userType, notificationIds) => {
    const ids = (notificationIds || []).filter((i) => mongoose.Types.ObjectId.isValid(i));
    await Notification.deleteMany({ _id: { $in: ids }, recipientId: userId, recipientType: userType });
};

const deleteRead = async (userId, userType) => {
    const r = await Notification.deleteMany({ recipientId: userId, recipientType: userType, isRead: true });
    return r.deletedCount || 0;
};

// ─── Event templates ─────────────────────────────────────────────────────────
// Variables use {{name}} and are substituted per recipient. {{studentName}} and
// {{libraryName}} are filled automatically.
const TEMPLATES = {
    'approval': {
        audience: 'students', type: 'approval',
        title: 'Registration approved',
        body: 'Hi {{studentName}}, your registration at {{libraryName}} has been approved. Welcome!'
    },
    'fee-due': {
        audience: 'students', type: 'fee_alert',
        title: 'Fee due',
        body: 'Hi {{studentName}}, a payment of Rs. {{amount}} is due on {{dueDate}}. Please pay to continue your membership.'
    },
    'payment-received': {
        audience: 'students', type: 'payment_alert',
        title: 'Payment received',
        body: 'Hi {{studentName}}, we received your payment of Rs. {{amount}}. Receipt: {{receiptNo}}. Thank you!'
    },
    'membership-expiry': {
        audience: 'students', type: 'plan_alert',
        title: 'Membership expiring soon',
        body: 'Hi {{studentName}}, your membership expires on {{expiryDate}}. Renew now to keep your seat.'
    },
    'renewal': {
        audience: 'students', type: 'plan_alert',
        title: 'Membership renewed',
        body: 'Hi {{studentName}}, your membership has been renewed until {{expiryDate}}.'
    },
    'enquiry': {
        audience: 'admins', type: 'enquiry_alert',
        title: 'New enquiry',
        body: 'New enquiry from {{name}} ({{mobile}}){{messageSuffix}}.'
    },
    'notice': {
        audience: 'students', type: 'notice',
        title: '{{title}}',
        body: '{{message}}'
    },
    'complaint-new': {
        audience: 'admins', type: 'complaint_alert',
        title: 'New complaint',
        body: 'New {{category}} complaint from {{fromName}}: {{subject}}.'
    },
    'complaint-update': {
        audience: 'students', type: 'complaint_update',
        title: 'Complaint update',
        body: 'Hi {{studentName}}, your complaint "{{subject}}" is now {{status}}.'
    },
    'library-status': {
        audience: 'admins', type: 'approval',
        title: 'Library {{status}}',
        body: 'Your library {{libraryName}} has been {{status}}.{{reasonSuffix}}'
    },
    'payment-adjusted': {
        audience: 'students', type: 'payment_alert',
        title: 'Payment {{action}}',
        body: 'Hi {{studentName}}, your payment of Rs. {{amount}} was {{action}}.{{receiptSuffix}}'
    },
    'seat-update': {
        audience: 'students', type: 'seat_alert',
        title: 'Seat update',
        body: 'Hi {{studentName}}, your seat has been {{action}}{{seatSuffix}}.'
    },
    // SaaS subscription lifecycle (to the library owner)
    'subscription-expiring': {
        audience: 'admins', type: 'subscription_alert',
        title: 'Subscription renews in {{daysLeft}} day(s)',
        body: 'Your {{planName}} subscription ends on {{expiryDate}}. Renew now to avoid losing access to {{libraryName}}.'
    },
    'subscription-grace': {
        audience: 'admins', type: 'subscription_alert',
        title: 'Subscription ended - grace period',
        body: 'Your subscription for {{libraryName}} has ended. You have until {{graceEndsOn}} to renew before the library is suspended.'
    },
    'subscription-suspended': {
        audience: 'admins', type: 'subscription_alert',
        title: 'Library suspended',
        body: '{{libraryName}} was suspended because the subscription expired. Renew your plan to reactivate it instantly.'
    },
    'subscription-reinstated': {
        audience: 'admins', type: 'subscription_alert',
        title: 'Library reactivated',
        body: 'Thank you! Your payment was received and {{libraryName}} is active again.'
    },
    // Support tickets (library <-> platform)
    'support-ticket-reply': {
        audience: 'admins', type: 'support_alert',
        title: 'Support replied: {{subject}}',
        body: '{{message}}'
    },
    'support-ticket-update': {
        audience: 'admins', type: 'support_alert',
        title: 'Support ticket {{status}}: {{subject}}',
        body: 'Your support ticket "{{subject}}" is now {{status}}.'
    },
    'announcement': {
        audience: 'students', type: 'announcement',
        title: '{{title}}',
        body: '{{message}}'
    }
};

const render = (tpl, vars) =>
    String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
        const v = vars[k];
        return v === undefined || v === null ? '' : String(v);
    }).replace(/\s+/g, ' ').trim();

// ─── Channels ────────────────────────────────────────────────────────────────
// SMS / WhatsApp provider interface. A provider is { send: async ({ to, message, title }) => void }.
// Until one is registered the channel is recorded as 'not_configured'.
const providers = { sms: null, whatsapp: null, email: null };
const registerProvider = (channel, provider) => {
    if (!['sms', 'whatsapp', 'email'].includes(channel)) throw new Error('Unknown channel');
    if (provider && typeof provider.send !== 'function') throw new Error('Provider must implement send()');
    providers[channel] = provider || null;
};

const tryRequire = (name) => { try { return require(name); } catch (_) { return null; } };

// Provider configuration (Super Admin "notification providers" setting, falling back to SMTP_* env vars).
// Secrets are only ever read from environment variables named in the setting. See notificationProviderConfig.service.
const providerConfig = require('./notificationProviderConfig.service');
const getProviderConfig = () => providerConfig.effectiveConfig();
const refreshProviderConfig = () => providerConfig.loadProviderConfig();

let mailTransport; // undefined = not tried, null = unavailable
let mailTransportSig = null;
const getMailTransport = () => {
    const cfg = getProviderConfig().email;
    const sig = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user, !!cfg.pass]);
    if (mailTransport !== undefined && sig === mailTransportSig) return mailTransport;
    mailTransportSig = sig;
    const nodemailer = tryRequire('nodemailer');
    if (!nodemailer || !cfg.host) {
        mailTransport = null;
    } else {
        mailTransport = nodemailer.createTransport({
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
            auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined
        });
    }
    return mailTransport;
};

const sendEmail = async (to, title, message) => {
    if (!to) return { status: 'skipped', error: 'No email address' };
    if (providers.email) {
        try { await providers.email.send({ to, title, message }); return { status: 'sent' }; }
        catch (e) { return { status: 'failed', error: e.message }; }
    }
    await providerConfig.ensureFresh();
    const transport = getMailTransport();
    if (!transport) {
        console.log(`[notify] email skipped (nodemailer/SMTP not configured): ${title}`);
        return { status: 'skipped', error: 'Email transport not available' };
    }
    try {
        await transport.sendMail({ from: getProviderConfig().email.from, to, subject: title, text: message });
        return { status: 'sent' };
    } catch (e) {
        return { status: 'failed', error: e.message };
    }
};

const sendViaProvider = async (channel, to, title, message) => {
    const provider = providers[channel];
    if (!provider) return { status: 'not_configured' };
    if (!to) return { status: 'skipped', error: 'No phone number' };
    try {
        await provider.send({ to, title, message });
        return { status: 'sent' };
    } catch (e) {
        return { status: 'failed', error: e.message };
    }
};

// ─── Preferences ─────────────────────────────────────────────────────────────
// library.notificationPrefs = { push, email, sms, whatsapp: boolean, events: { [event]: boolean } }
// user.notificationPrefs (optional, when the model has it) uses the same channel keys.
const channelAllowed = (libPrefs, userPrefs, channel) => {
    if (channel === 'inapp') return true; // the inbox is always written
    const key = channel === 'push' ? 'push' : channel;
    if (libPrefs && libPrefs[key] === false) return false;
    if (userPrefs && userPrefs[key] === false) return false;
    return true;
};

const DEFAULT_CHANNELS = ['inapp', 'push'];
const ALL_CHANNELS = ['inapp', 'push', 'email', 'sms', 'whatsapp'];

/**
 * Fire a templated notification event.
 *
 * notifyEvent('fee-due', libraryId, {
 *   studentId | studentIds,        // student recipients (must belong to libraryId)
 *   toAdmins: true | adminIds: [], // admin/staff recipients of the library
 *   variables: { amount, dueDate },// merged into the template
 *   data: { ... },                 // payload stored with the notification and sent with push
 *   channels: ['inapp','push'],    // default inapp + push
 *   title, message                 // override the template
 * })
 * Resolves with { recipients, deliveries } and never throws.
 */
const notifyEvent = async (eventName, libraryId, payload = {}) => {
    const summary = { event: eventName, recipients: 0, deliveries: [] };
    try {
        const tpl = TEMPLATES[eventName];
        if (!tpl && !(payload.title && payload.message)) throw new Error(`Unknown notification event: ${eventName}`);
        const template = tpl || { audience: 'students', type: 'system_alert', title: '', body: '' };
        const libId = libraryId && libraryId._id ? libraryId._id : libraryId;
        if (!libId) throw new Error('libraryId required');

        const Library = require('../models/library.model');
        const lib = await Library.findById(libId).select('name notificationPrefs').lean();
        const libPrefs = (lib && lib.notificationPrefs) || {};
        // Library-level opt-outs for owner alerts / reminders
        const PREF_KEY = { enquiry: 'newEnquiry', 'complaint-new': 'newComplaint', 'fee-due': 'feeReminders', 'membership-expiry': 'expiryReminders' };
        if (PREF_KEY[eventName] && libPrefs[PREF_KEY[eventName]] === false) {
            summary.skipped = 'event disabled by library';
            return summary;
        }
        if (libPrefs.events && libPrefs.events[eventName] === false) {
            summary.skipped = 'event disabled by library';
            return summary;
        }

        const requested = Array.isArray(payload.channels) && payload.channels.length
            ? payload.channels.filter((c) => ALL_CHANNELS.includes(c)) : DEFAULT_CHANNELS;
        const channels = [...new Set(['inapp', ...requested])];

        // Resolve recipients, always scoped to the library
        const recipients = [];
        if (payload.studentId || payload.studentIds) {
            const Student = require('../models/student.model');
            const ids = [...(payload.studentIds || []), ...(payload.studentId ? [payload.studentId] : [])]
                .filter((i) => mongoose.Types.ObjectId.isValid(i));
            const students = await Student.find({ _id: { $in: ids }, libraryId: libId, isDeleted: false });
            students.forEach((s) => recipients.push({ doc: s, type: 'Student' }));
        }
        if (payload.toAdmins || payload.adminIds || template.audience === 'admins') {
            const Admin = require('../models/admin.model');
            const filter = { libraryId: libId, isDeleted: false, status: true };
            if (payload.adminIds) filter._id = { $in: payload.adminIds.filter((i) => mongoose.Types.ObjectId.isValid(i)) };
            const admins = await Admin.find(filter);
            admins.forEach((a) => recipients.push({ doc: a, type: 'Admin' }));
        }
        // Idempotency: payload.dedupeKey skips recipients already notified for this event+key
        if (payload.dedupeKey && recipients.length) {
            const done = await Notification.find({
                libraryId: libId, event: eventName, 'data.dedupeKey': String(payload.dedupeKey),
                recipientId: { $in: recipients.map((r) => r.doc._id) }
            }).select('recipientId').lean();
            const doneSet = new Set(done.map((d) => String(d.recipientId)));
            for (let i = recipients.length - 1; i >= 0; i--) if (doneSet.has(String(recipients[i].doc._id))) recipients.splice(i, 1);
        }
        summary.recipients = recipients.length;
        if (!recipients.length) return summary;

        // Per-recipient rendered content
        const baseVars = { libraryName: lib?.name || '', ...(payload.variables || {}) };
        const prepared = recipients.map((r) => {
            const vars = { ...baseVars, studentName: r.doc.name || '', recipientName: r.doc.name || '' };
            return {
                ...r,
                title: payload.title || render(template.title, vars),
                message: payload.message || render(template.body, vars)
            };
        });

        // Push: one batched send for everyone, then map results back per recipient
        const pushResult = {};
        const pushRecipients = prepared.filter((r) => channels.includes('push') && channelAllowed(libPrefs, r.doc.notificationPrefs, 'push'));
        if (pushRecipients.length) {
            const { sendToTokens } = require('./firebase.service');
            // group identical (title, message) so common broadcasts go in one multicast
            const groups = new Map();
            for (const r of pushRecipients) {
                const k = `${r.title}\u0000${r.message}`;
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k).push(r);
            }
            for (const group of groups.values()) {
                const tokens = group.flatMap((r) => r.doc.fcmTokens || []);
                const res = tokens.length
                    ? await sendToTokens(tokens, group[0].title, group[0].message, { ...(payload.data || {}), event: eventName })
                    : null;
                const ok = new Set(res ? res.results.filter((x) => x.success).map((x) => x.token) : []);
                for (const r of group) {
                    const own = r.doc.fcmTokens || [];
                    if (!own.length) pushResult[r.doc._id] = { status: 'no_tokens' };
                    else if (!res.configured) pushResult[r.doc._id] = { status: 'not_configured' };
                    else if (own.some((t) => ok.has(t))) pushResult[r.doc._id] = { status: 'sent' };
                    else pushResult[r.doc._id] = { status: 'failed', error: 'delivery failed' };
                }
            }
        }

        // Build inbox rows (with delivery statuses) after other channels were attempted
        const rows = [];
        for (const r of prepared) {
            const deliveries = [{ channel: 'inapp', status: 'sent' }];
            for (const ch of channels) {
                if (ch === 'inapp') continue;
                if (!channelAllowed(libPrefs, r.doc.notificationPrefs, ch)) {
                    deliveries.push({ channel: ch, status: 'opted_out' });
                } else if (ch === 'push') {
                    deliveries.push({ channel: 'push', ...(pushResult[r.doc._id] || { status: 'skipped' }) });
                } else if (ch === 'email') {
                    deliveries.push({ channel: 'email', ...(await sendEmail(r.doc.email, r.title, r.message)) });
                } else {
                    deliveries.push({ channel: ch, ...(await sendViaProvider(ch, r.doc.mobile, r.title, r.message)) });
                }
            }
            rows.push({
                recipientId: r.doc._id, recipientType: r.type, libraryId: libId,
                type: template.type, event: eventName, title: r.title, message: r.message,
                data: payload.dedupeKey ? { ...(payload.data || {}), dedupeKey: String(payload.dedupeKey) } : (payload.data || {}), deliveries
            });
            deliveries.forEach((d) => summary.deliveries.push({ recipientId: r.doc._id, ...d }));
        }
        await Notification.insertMany(rows);
    } catch (e) {
        console.error(`notifyEvent(${eventName}) failed:`, e.message);
        summary.error = e.message;
    }
    return summary;
};

/**
 * Tell the library owner about a status change (approved | rejected | suspended | reinstated).
 * Never throws. Pass ownerId when known to avoid the lookup.
 */
const notifyLibraryStatus = async (library, status, reason = '', { ownerId, data } = {}) => {
    try {
        const libId = library._id || library;
        let owner = ownerId;
        if (!owner) {
            const Admin = require('../models/admin.model');
            const o = await Admin.findOne({ libraryId: libId, userType: 'admin', isDeleted: false }).select('_id').lean();
            owner = o && o._id;
        }
        if (!owner) return { recipients: 0 };
        return await notifyEvent('library-status', libId, {
            adminIds: [owner], channels: ['inapp', 'push', 'email'],
            variables: { status, reasonSuffix: reason ? ` Reason: ${reason}` : '' },
            data: { type: `library_${status}`, ...(data || {}) },
            dedupeKey: `status:${status}:${Date.now() - (Date.now() % 60000)}`
        });
    } catch (e) { return { error: e.message }; }
};

// ─── OTP delivery ────────────────────────────────────────────────────────────
// deliverOtp({ channel:'sms'|'email', to, otp, purpose }) -> { status }. Never logs the OTP.
let warnedNoProvider = false;
const deliverOtp = async ({ channel, to, otp, purpose = 'verification' }) => {
    try {
        const ch = channel === 'email' ? 'email' : 'sms';
        if (!to || !otp) return { status: 'skipped' };
        const message = `Your DDdesk OTP for ${purpose} is ${otp}. Valid for 10 minutes. Do not share it.`;
        const provider = providers[ch];
        if (!provider) {
            if (ch === 'email' && getMailTransport()) return await sendEmail(to, 'Your DDdesk OTP', message);
            if (!warnedNoProvider && process.env.NODE_ENV !== 'development') {
                warnedNoProvider = true;
                console.warn(`[otp] no ${ch} provider configured; OTPs are not being delivered`);
            }
            return { status: 'not_configured' };
        }
        await provider.send({ to, title: 'Your DDdesk OTP', message });
        return { status: 'sent' };
    } catch (e) {
        return { status: 'failed', error: e.message };
    }
};

// Registers env-configured HTTP adapters (idempotent)
const initProviders = () => {
    try {
        if (process.env.SMS_API_URL && !providers.sms) registerProvider('sms', require('./providers/httpSms.provider').create());
        if (process.env.EMAIL_API_URL && !providers.email) registerProvider('email', require('./providers/httpEmail.provider').create());
    } catch (e) { console.error('[notify] provider init failed:', e.message); }
};
initProviders();

/** E-mail to a platform owner (settings alerts, test e-mail). Same transport/provider as every other e-mail. */
const sendPlatformEmail = (to, title, message) => sendEmail(to, title, message);

module.exports = {
    sendPlatformEmail,
    notifyLibraryStatus, deliverOtp, initProviders,
    getNotifications, markAllAsRead, markOneAsRead, deleteNotifications, broadcastToStudents, AUDIENCES, deleteRead,
    notifyEvent, registerProvider, TEMPLATES, render,
    getProviderConfig, refreshProviderConfig
};
