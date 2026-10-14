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
