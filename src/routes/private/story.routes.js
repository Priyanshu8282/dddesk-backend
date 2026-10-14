const express = require('express');
const storyController = require('../../controllers/story.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireStudent, requirePermission } = require('../../middlewares/access.middleware');
const { storyValidation: v } = require('../../validations');

const router = express.Router();

// ── Student-facing (static paths first so they are never captured by /:id) ──
router.get('/student', requireStudent, storyController.getStoriesForStudent);
router.post('/view/:id', requireStudent, validate(v.idParam), storyController.markStoryViewed);
router.post('/like/:id', requireStudent, validate(v.idParam), storyController.likeStory);
router.post('/reply/:id', requireStudent, validate(v.reply), storyController.replyToStory);

// ── Staff-only management ───────────────────────────────────────────────────
router.get('/analytics', requireStaff, requirePermission('content.view'), storyController.getAnalytics);
router.post('/', requireStaff, requirePermission('content.create'), upload.single('media'), validate(v.createStory), storyController.createStory);
router.get('/', requireStaff, requirePermission('content.view'), validate(v.listStories), storyController.getStories);
router.put('/toggle/:id', requireStaff, requirePermission('content.publish'), validate(v.idParam), storyController.toggleStoryActive);
router.get('/:id', requireStaff, requirePermission('content.view'), validate(v.idParam), storyController.getStoryById);
router.put('/:id', requireStaff, requirePermission('content.create'), upload.single('media'), validate(v.updateStory), storyController.updateStory);
router.delete('/:id', requireStaff, requirePermission('content.publish'), validate(v.idParam), storyController.deleteStory);

module.exports = router;
