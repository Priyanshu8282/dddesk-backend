const express = require('express');
const notificationController = require('../../controllers/notification.controller');

const router = express.Router();

// Every authenticated user (staff or student) can manage only their own inbox
router.get('/', notificationController.getMyNotifications);
router.patch('/read-all', notificationController.markMyNotificationsAsRead);
router.post('/delete', notificationController.deleteNotifications);
router.patch('/:id/read', notificationController.markOneAsRead);

module.exports = router;
