const express = require('express');
const router = express.Router();
const noticeController = require('./notice.controller');
const Authentication = require('../../middlewares/auth.middleware');
const upload = require('../../middlewares/upload.middleware');

// Apply authentication middleware globally to all notice routes
router.use(Authentication);

// Admin-facing endpoints
router.post('/', upload.single('media'), noticeController.createNotice);
router.get('/', noticeController.getNotices);
router.get('/:id', noticeController.getNoticeById);
router.put('/toggle/:id', noticeController.toggleNoticeActive);
router.put('/:id', upload.single('media'), noticeController.updateNotice);
router.delete('/:id', noticeController.deleteNotice);

// Student-facing endpoints
router.get('/student', noticeController.getNoticesForStudent);
router.post('/view/:id', noticeController.markNoticeViewed);

module.exports = router;
