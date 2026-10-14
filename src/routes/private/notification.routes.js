const express = require('express');
const notificationController = require('../../controllers/notification.controller');

const router = express.Router();

router.get('/', notificationController.getMyNotifications);
router.patch('/read-all', notificationController.markMyNotificationsAsRead);
router.post('/delete', notificationController.deleteNotifications);

module.exports = router;
