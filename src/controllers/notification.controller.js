const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const notificationService = require('../services/notification.service');

const who = (req) => {
    const userId = req.user ? req.user._id : null;
    if (!userId) throw new ApiError(401, 'Unauthorized');
    return { userId, userType: req.userType === 'student' ? 'Student' : 'Admin' };
};

exports.getMyNotifications = catchAsync(async (req, res) => {
    const { userId, userType } = who(req);
    const result = await notificationService.getNotifications(userId, userType, req.query);
    // `notifications` + `unreadCount` kept at top level for existing clients
    ApiResponse.ok(res, result.notifications, 'Notifications retrieved successfully', {
        notifications: result.notifications,
        unreadCount: result.unreadCount,
        total: result.total,
        stats: result.stats,
        types: result.types,
        page: result.page,
        totalPages: result.totalPages
    });
});

exports.markMyNotificationsAsRead = catchAsync(async (req, res) => {
    const { userId, userType } = who(req);
    await notificationService.markAllAsRead(userId, userType);
    ApiResponse.ok(res, null, 'All notifications marked as read successfully');
});

exports.markOneAsRead = catchAsync(async (req, res) => {
    const { userId, userType } = who(req);
    const n = await notificationService.markOneAsRead(req.params.id, userId, userType);
    ApiResponse.ok(res, n, 'Notification marked as read');
});

exports.deleteNotifications = catchAsync(async (req, res) => {
    const { userId, userType } = who(req);
    const { notificationIds } = req.body;
    if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
        throw new ApiError(400, 'Invalid or missing notificationIds array');
    }
    await notificationService.deleteNotifications(userId, userType, notificationIds);
    ApiResponse.ok(res, null, 'Notifications deleted successfully');
});

exports.deleteReadNotifications = catchAsync(async (req, res) => {
    const { userId, userType } = who(req);
    const n = await notificationService.deleteRead(userId, userType);
    ApiResponse.ok(res, { deleted: n }, 'Read notifications deleted');
});

exports.sendToStudents = catchAsync(async (req, res) => {
    if (!req.libraryId) throw new ApiError(400, 'Library context required');
    const result = await notificationService.broadcastToStudents(req.libraryId, req.body);
    ApiResponse.ok(res, result, `Sent to ${result.recipients} student${result.recipients === 1 ? '' : 's'}`);
});

// ─── Browser push ────────────────────────────────────────────────────────────
const webPush = require('../services/webPush.service');
const Notification = require('../models/notification.model');

exports.pushKey = catchAsync(async (req, res) => {
    ApiResponse.ok(res, { publicKey: await webPush.getPublicKey() }, 'Push key');
});

exports.pushStatus = catchAsync(async (req, res) => {
    const { userId, userType } = who(req);
    ApiResponse.ok(res, { subscriptions: await webPush.count(userId, userType) }, 'Push status');
});

exports.pushSubscribe = catchAsync(async (req, res) => {
    const { userId, userType } = who(req);
    await webPush.subscribe({ userId, userType, libraryId: req.libraryId, subscription: req.body.subscription, userAgent: req.get('user-agent') });
    ApiResponse.ok(res, { subscriptions: await webPush.count(userId, userType) }, 'Browser notifications are on');
});

exports.pushUnsubscribe = catchAsync(async (req, res) => {
    const { userId, userType } = who(req);
    await webPush.unsubscribe({ userId, endpoint: req.body.endpoint });
    ApiResponse.ok(res, { subscriptions: await webPush.count(userId, userType) }, 'Browser notifications are off');
});

// Creates a real notification for the caller, so the whole path (inbox, browser push, sound) is exercised
exports.pushTest = catchAsync(async (req, res) => {
    const { userId, userType } = who(req);
    await Notification.create({
        recipientId: userId, recipientType: userType, libraryId: req.libraryId || undefined,
        type: 'system_alert', title: 'Test notification', message: 'Notifications are working on this device.',
        data: { url: '/dashboard/notifications', test: true }
    });
    ApiResponse.ok(res, null, 'Test notification sent');
});
