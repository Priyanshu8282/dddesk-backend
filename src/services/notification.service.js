const Notification = require('../models/notification.model');

exports.getNotifications = async (userId, userType) => {
    const notifications = await Notification.find({
        recipientId: userId,
        recipientType: userType
    }).sort({ createdAt: -1 }).limit(50);

    const unreadCount = await Notification.countDocuments({
        recipientId: userId,
        recipientType: userType,
        isRead: false
    });

    return { notifications, unreadCount };
};

exports.markAllAsRead = async (userId, userType) => {
    await Notification.updateMany(
        { recipientId: userId, recipientType: userType, isRead: false },
        { $set: { isRead: true } }
    );
};

exports.deleteNotifications = async (userId, userType, notificationIds) => {
    await Notification.deleteMany({
        _id: { $in: notificationIds },
        recipientId: userId,
        recipientType: userType
    });
};
