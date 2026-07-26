const express = require('express');
const router = express.Router();
const storyController = require('./story.controller');
const Authentication = require('../../middlewares/auth.middleware');
const upload = require('../../middlewares/upload.middleware');

// Apply authentication middleware globally to all story routes
router.use(Authentication);

// Admin-facing actions
router.post('/', upload.single('media'), storyController.createStory);
router.get('/', storyController.getStories);
router.get('/:id', storyController.getStoryById);
router.put('/toggle/:id', storyController.toggleStoryActive);
router.put('/:id', upload.single('media'), storyController.updateStory);
router.delete('/:id', storyController.deleteStory);

// Student-facing actions
router.get('/student', storyController.getStoriesForStudent);
router.post('/view/:id', storyController.markStoryViewed);
router.post('/like/:id', storyController.likeStory);
router.post('/reply/:id', storyController.replyToStory);

module.exports = router;
