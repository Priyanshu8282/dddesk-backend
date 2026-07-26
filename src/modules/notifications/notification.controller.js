const notificationService = require('./notification.service');

exports.getMyNotifications = async (req, res) => {
    try {
        const userId = req.user ? (req.user._id || req.user.id) : null;
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

        const userType = req.userType === 'student' ? 'Student' : 'Admin';

        const { notifications, unreadCount } = await notificationService.getNotifications(userId, userType);

        res.json({ success: true, notifications, unreadCount });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.markMyNotificationsAsRead = async (req, res) => {
    try {
        const userId = req.user ? (req.user._id || req.user.id) : null;
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

        const userType = req.userType === 'student' ? 'Student' : 'Admin';

        await notificationService.markAllAsRead(userId, userType);
        
        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};

exports.deleteNotifications = async (req, res) => {
    try {
        const userId = req.user ? (req.user._id || req.user.id) : null;
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

        const userType = req.userType === 'student' ? 'Student' : 'Admin';
        const { notificationIds } = req.body;

        if (!notificationIds || !Array.isArray(notificationIds) || notificationIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid or missing notificationIds' });
        }

        await notificationService.deleteNotifications(userId, userType, notificationIds);

        res.json({ success: true, message: 'Notifications deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
};
