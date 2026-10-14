/**
 * Super admin platform tooling (spec 5.3 / 5.4): announcements, system events.
 */
const mongoose = require('mongoose');
const PlatformAnnouncement = require('../models/platformAnnouncement.model');
const PlatformPayment = require('../models/platformPayment.model');
const PaymentTransaction = require('../models/paymentTransaction.model');
const Notification = require('../models/notification.model');
const WebhookEvent = require('../models/webhookEvent.model');
const Library = require('../models/library.model');
const CronLock = require('../models/cronLock.model');
const GlobalSetting = require('../models/setting.model');
const ApiError = require('../utils/ApiError');
const pick = require('../utils/pick');

const clampPaging = (q = {}) => ({
    page: Math.max(1, parseInt(q.page, 10) || 1),
    limit: Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20))
});

// ---- announcements -------------------------------------------------------
const FIELDS = ['title', 'body', 'audience', 'severity', 'startsAt', 'endsAt', 'isActive'];

exports.createAnnouncement = async (req) => PlatformAnnouncement.create({ ...pick(req.body, FIELDS), createdBy: req.user._id });

exports.listAnnouncements = async (query = {}) => {
    const { page, limit } = clampPaging(query);
    const filter = {};
    if (query.audience) filter.audience = String(query.audience);
    if (query.isActive !== undefined) filter.isActive = String(query.isActive) === 'true';
    const [data, total] = await Promise.all([
        PlatformAnnouncement.find(filter).populate('createdBy', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        PlatformAnnouncement.countDocuments(filter)
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
};

exports.getAnnouncement = async (id) => {
    const a = await PlatformAnnouncement.findById(id).lean();
    if (!a) throw new ApiError(404, 'Announcement not found');
    return a;
};

exports.updateAnnouncement = async (id, body) => {
    const update = pick(body, FIELDS);
    if (!Object.keys(update).length) throw new ApiError(400, 'No valid fields to update');
    const existing = await PlatformAnnouncement.findById(id).select('startsAt endsAt').lean();
    if (!existing) throw new ApiError(404, 'Announcement not found');
    const startsAt = update.startsAt !== undefined ? update.startsAt : existing.startsAt;
    const endsAt = update.endsAt !== undefined ? update.endsAt : existing.endsAt;
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) throw new ApiError(400, 'endsAt must be after startsAt');
    const a = await PlatformAnnouncement.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true });
    if (!a) throw new ApiError(404, 'Announcement not found');
    return a;
};

exports.deleteAnnouncement = async (id) => {
    const a = await PlatformAnnouncement.findByIdAndDelete(id);
    if (!a) throw new ApiError(404, 'Announcement not found');
    return a;
};

/** Audiences a caller belongs to, by account type */
const audiencesFor = (userType) => {
    if (userType === 'admin') return ['all', 'owners'];
    if (userType === 'staff') return ['all', 'staff'];
    if (userType === 'student') return ['all', 'students'];
    return ['all', 'owners', 'staff', 'students']; // superadmin previews everything
};
exports.audiencesFor = audiencesFor;

exports.activeFor = async (userType, now = new Date()) =>
    PlatformAnnouncement.find({
        isActive: true,
        audience: { $in: audiencesFor(userType) },
        $and: [
            { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
            { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }
        ]
    }).select('title body audience severity startsAt endsAt createdAt').sort({ createdAt: -1 }).limit(20).lean();

// ---- system events -------------------------------------------------------
exports.systemEvents = async ({ limit = 20, days = 7 } = {}) => {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const lim = Math.min(50, Math.max(1, limit));
    const [subFailed, subFailedCount, onlineFailed, onlineFailedCount, notifFailed, notifFailedCount, webhooks, webhookCount, suspended, suspendedCount, locks, lastRun] = await Promise.all([
        PlatformPayment.find({ status: 'failed', updatedAt: { $gte: since } }).populate('libraryId', 'name').sort({ updatedAt: -1 }).limit(lim)
            .select('libraryId amount period failureReason updatedAt invoiceNo').lean(),
        PlatformPayment.countDocuments({ status: 'failed', updatedAt: { $gte: since } }),
        PaymentTransaction.find({ status: 'failed', updatedAt: { $gte: since } }).populate('libraryId', 'name').sort({ updatedAt: -1 }).limit(lim)
            .select('libraryId amount failureReason updatedAt needsReview').lean(),
        PaymentTransaction.countDocuments({ status: 'failed', updatedAt: { $gte: since } }),
        Notification.find({ 'deliveries.status': 'failed', createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(lim)
            .select('libraryId event type title deliveries createdAt').lean(),
        Notification.countDocuments({ 'deliveries.status': 'failed', createdAt: { $gte: since } }),
        WebhookEvent.find({ status: 'failed', updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(lim).select('eventId event error updatedAt').lean(),
        WebhookEvent.countDocuments({ status: 'failed', updatedAt: { $gte: since } }),
        Library.find({ status: 'suspended', isDeleted: false }).sort({ updatedAt: -1 }).limit(lim).select('name libraryCode statusReason updatedAt').lean(),
        Library.countDocuments({ status: 'suspended', isDeleted: false }),
        CronLock.find({}).sort({ lockedUntil: -1 }).limit(lim).lean(),
        GlobalSetting.findOne({ key: 'cron:subscription-lifecycle:lastRun' }).lean()
    ]);
    const now = Date.now();
    return {
        since, days,
        counts: {
            failedSubscriptionPayments: subFailedCount, failedOnlinePayments: onlineFailedCount,
            failedNotifications: notifFailedCount, failedWebhooks: webhookCount, suspendedLibraries: suspendedCount
        },
        failedSubscriptionPayments: subFailed,
        failedOnlinePayments: onlineFailed,
        failedNotifications: notifFailed.map((n) => ({
            _id: n._id, libraryId: n.libraryId, event: n.event || n.type, title: n.title, createdAt: n.createdAt,
            failedChannels: (n.deliveries || []).filter((d) => d.status === 'failed').map((d) => ({ channel: d.channel, error: d.error }))
        })),
        failedWebhooks: webhooks,
        suspendedLibraries: suspended,
        cron: {
            locks: locks.map((l) => ({ job: l._id, lockedUntil: l.lockedUntil, active: new Date(l.lockedUntil).getTime() > now })),
            subscriptionLifecycleLastRun: lastRun ? lastRun.value : null
        }
    };
};
