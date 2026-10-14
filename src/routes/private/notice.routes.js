const express = require('express');
const router = express.Router();
const noticeController = require('../../controllers/notice.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { noticeValidation } = require('../../validations');

// Admin-facing endpoints
router.post('/', upload.single('media'), validate(noticeValidation.createNotice), noticeController.createNotice);
router.get('/', noticeController.getNotices);
router.get('/:id', noticeController.getNoticeById);
router.put('/toggle/:id', noticeController.toggleNoticeActive);
router.put('/:id', upload.single('media'), noticeController.updateNotice);
router.delete('/:id', noticeController.deleteNotice);

// Student-facing endpoints
router.get('/student', noticeController.getNoticesForStudent);
router.post('/view/:id', noticeController.markNoticeViewed);

module.exports = router;
