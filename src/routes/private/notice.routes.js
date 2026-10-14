const express = require('express');
const noticeController = require('../../controllers/notice.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireStudent, requirePermission } = require('../../middlewares/access.middleware');
const { noticeValidation: v } = require('../../validations');

const router = express.Router();

// ── Student-facing (static paths before /:id) ───────────────────────────────
router.get('/student', requireStudent, noticeController.getNoticesForStudent);
router.post('/view/:id', requireStudent, validate(v.idParam), noticeController.markNoticeViewed);

// ── Staff-only management ───────────────────────────────────────────────────
router.post('/', requireStaff, requirePermission('content.create'), upload.single('media'), validate(v.createNotice), noticeController.createNotice);
router.get('/', requireStaff, requirePermission('content.view'), validate(v.listNotices), noticeController.getNotices);
router.put('/toggle/:id', requireStaff, requirePermission('content.publish'), validate(v.idParam), noticeController.toggleNoticeActive);
router.patch('/:id/publish', requireStaff, requirePermission('content.publish'), validate(v.idParam), noticeController.publishNotice);
router.patch('/:id/unpublish', requireStaff, requirePermission('content.publish'), validate(v.idParam), noticeController.unpublishNotice);
router.get('/:id', requireStaff, requirePermission('content.view'), validate(v.idParam), noticeController.getNoticeById);
router.put('/:id', requireStaff, requirePermission('content.create'), upload.single('media'), validate(v.updateNotice), noticeController.updateNotice);
router.delete('/:id', requireStaff, requirePermission('content.publish'), validate(v.idParam), noticeController.deleteNotice);

module.exports = router;
