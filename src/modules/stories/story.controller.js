const storyService = require('./story.service');
const Story = require('./story.model');

/**
 * Create a new Story (Admin only)
 */
exports.createStory = async (req, res, next) => {
    try {
        const storyData = { ...req.body };

        // Handle file upload
        if (req.file) {
            storyData.url = req.file.path;
        } else {
            return res.status(400).json({ success: false, message: 'Media file is required' });
        }

        // Automatic library link based on logged in Admin
        if (req.userType === 'admin' || (req.user && req.user.libraryId)) {
            storyData.libraryId = req.user.libraryId;
        }

        if (!storyData.libraryId) {
            return res.status(400).json({ success: false, message: 'Library ID is required' });
        }

        const creatorInfo = req.user ? { id: req.user._id || req.user.id } : null;
        const story = await storyService.createStory(storyData, creatorInfo);

        const { notifyLibraryAdmins, notifyMultipleStudents } = require('../../services/firebase.service');
        notifyLibraryAdmins(
            storyData.libraryId,
            "📢 Story Published Successfully",
            `${storyData.title || 'A new story'} was uploaded.`
        );

        // Notify Students
        const Student = require('../students/student.model');
        const allStudents = await Student.find({ libraryId: storyData.libraryId, status: 'active', isDeleted: false });
        const studentIds = allStudents.map(s => s._id);

        if (studentIds.length > 0) {
            await notifyMultipleStudents(
                studentIds,
                "🎉 New Library Offer",
                `${storyData.title || 'A new story/offer is available!'}`,
                { storyId: story._id.toString() },
                'story_alert'
            );
        }

        res.status(201).json({
            success: true,
            message: 'Story created successfully',
            data: story
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get stories list with dynamic dashboard analytics (Admin only)
 */
exports.getStories = async (req, res, next) => {
    try {
        const libraryId = req.user?.libraryId || req.query.libraryId;
        if (!libraryId) {
            return res.status(400).json({ success: false, message: 'Library ID is required' });
        }

        const { search = "", page = 1, limit = 10 } = req.query;
        const filter = { libraryId };

        if (search) {
            filter.$or = [
                { title: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
            ];
        }

        const result = await storyService.queryStories(filter, { page, limit });

        // Calculate dynamic dashboard insights
        const now = new Date();
        const past24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const totalActive = await Story.countDocuments({
            libraryId,
            isActive: true,
            expiresAt: { $gt: now }
        });

        const allStories = await Story.find({ libraryId });
        const totalViews = allStories.reduce((sum, s) => sum + (s.views || 0), 0);

        const todayStories = await Story.find({
            libraryId,
            createdAt: { $gte: past24h }
        });
        const todayViews = todayStories.reduce((sum, s) => sum + (s.views || 0), 0);

        const summary = {
            totalActive,
            totalViews,
            averageDuration: 24, // Stories always expire in 24 hours
            todayViews
        };

        res.status(200).json({
            success: true,
            results: result.results,
            page: result.page,
            limit: result.limit,
            totalResults: result.totalResults,
            summary
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get active unexpired stories for Student Dashboard
 */
exports.getStoriesForStudent = async (req, res, next) => {
    try {
        const libraryId = req.user?.libraryId || req.query.libraryId;
        if (!libraryId) {
            return res.status(400).json({ success: false, message: 'Library ID is required' });
        }

        const stories = await storyService.getActiveStudentStories(libraryId);
        res.status(200).json({
            success: true,
            data: stories
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Increment view count
 */
exports.markStoryViewed = async (req, res, next) => {
    try {
        const studentId = req.user?.id;
        const story = await storyService.incrementViews(req.params.id, studentId);
        res.status(200).json({
            success: true,
            message: 'Story marked as viewed',
            data: story
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Toggle like for a story
 */
exports.likeStory = async (req, res, next) => {
    try {
        const studentId = req.user?.id;
        const story = await storyService.toggleLike(req.params.id, studentId);
        res.status(200).json({
            success: true,
            message: 'Story like toggled',
            data: story
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Add a reply to a story
 */
exports.replyToStory = async (req, res, next) => {
    try {
        const studentId = req.user?.id;
        const { message } = req.body;
        if (!message) {
            return res.status(400).json({ success: false, message: 'Message is required' });
        }
        
        const story = await storyService.addReply(req.params.id, studentId, message);
        res.status(200).json({
            success: true,
            message: 'Reply sent',
            data: story
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Toggle Story active/inactive status
 */
exports.toggleStoryActive = async (req, res, next) => {
    try {
        const story = await storyService.getStoryById(req.params.id);
        if (!story) {
            return res.status(404).json({ success: false, message: 'Story not found' });
        }

        story.isActive = !story.isActive;
        await story.save();

        res.status(200).json({
            success: true,
            message: `Story status updated to ${story.isActive ? 'Active' : 'Inactive'}`,
            data: story
        });
    } catch (error) {
        next(error);
    }
};

exports.updateStory = async (req, res, next) => {
    try {
        const storyData = { ...req.body };
        
        // Handle optional file upload
        if (req.file) {
            storyData.url = req.file.path;
        }

        const story = await storyService.updateStory(req.params.id, storyData);
        res.status(200).json({
            success: true,
            message: 'Story updated successfully',
            data: story
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get story by ID
 */
exports.getStoryById = async (req, res, next) => {
    try {
        const story = await storyService.getStoryById(req.params.id);
        if (!story) {
            return res.status(404).json({ success: false, message: 'Story not found' });
        }
        res.status(200).json({
            success: true,
            data: story
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Delete a story
 */
exports.deleteStory = async (req, res, next) => {
    try {
        await storyService.deleteStory(req.params.id);
        res.status(200).json({
            success: true,
            message: 'Story deleted successfully'
        });
    } catch (error) {
        next(error);
    }
};
