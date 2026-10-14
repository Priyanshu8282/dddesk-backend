const express = require('express');
const router = express.Router();
const storyController = require('../../controllers/story.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { storyValidation } = require('../../validations');

// Admin-facing actions
router.post('/', upload.single('media'), validate(storyValidation.createStory), storyController.createStory);
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
