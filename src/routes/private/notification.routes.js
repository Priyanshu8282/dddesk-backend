const express = require('express');
const notificationController = require('../../controllers/notification.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff } = require('../../middlewares/access.middleware');
const v = require('../../validations/notification.validation');

const router = express.Router();

// Every authenticated user (staff or student) can manage only their own inbox
router.get('/', validate(v.listQuery), notificationController.getMyNotifications);
router.patch('/read-all', notificationController.markMyNotificationsAsRead);
router.post('/delete', notificationController.deleteNotifications);
router.post('/delete-read', notificationController.deleteReadNotifications);
// Library owner / staff announce to their own students
router.post('/send', requireStaff, validate(v.send), notificationController.sendToStudents);
router.patch('/:id/read', notificationController.markOneAsRead);

module.exports = router;
