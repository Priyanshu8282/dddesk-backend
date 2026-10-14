const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const notificationService = require('../services/notification.service');

exports.getMyNotifications = catchAsync(async (req, res) => {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) throw new ApiError(401, 'Unauthorized');

    const userType = req.userType === 'student' ? 'Student' : 'Admin';
    const { notifications, unreadCount } = await notificationService.getNotifications(userId, userType);

    res.status(200).json({
        success: true,
        message: 'Notifications retrieved successfully',
        data: notifications,
        notifications,
        unreadCount
    });
});

exports.markMyNotificationsAsRead = catchAsync(async (req, res) => {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) throw new ApiError(401, 'Unauthorized');

    const userType = req.userType === 'student' ? 'Student' : 'Admin';
    await notificationService.markAllAsRead(userId, userType);

    res.status(200).json({
        success: true,
        message: 'All notifications marked as read successfully'
    });
});

exports.deleteNotifications = catchAsync(async (req, res) => {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) throw new ApiError(401, 'Unauthorized');

    const userType = req.userType === 'student' ? 'Student' : 'Admin';
    const { notificationIds } = req.body;

    if (!notificationIds || !Array.isArray(notificationIds) || notificationIds.length === 0) {
        throw new ApiError(400, 'Invalid or missing notificationIds array');
    }

    await notificationService.deleteNotifications(userId, userType, notificationIds);

    res.status(200).json({
        success: true,
        message: 'Notifications deleted successfully'
    });
});
