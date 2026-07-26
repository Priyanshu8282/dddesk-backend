const Story = require('./story.model');
const Notification = require('../notifications/notification.model');
const Student = require('../students/student.model');

/**
 * Create a new Story
 */
const createStory = async (storyData, creatorInfo) => {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // Stories expire in 24 hours

    const story = await Story.create({
        ...storyData,
        expiresAt,
        createdBy: creatorInfo?.id
    });
    return story;
};

/**
 * Query stories for administrative list
 */
const queryStories = async (filter, options = {}) => {
    const { page = 1, limit = 100 } = options;
    const skip = (page - 1) * limit;

    const stories = await Story.find(filter)
        .sort({ createdAt: -1 })
        .populate('viewedBy.studentId', 'name profilePic')
        .populate('likedBy', 'name profilePic')
        .populate('repliesData.studentId', 'name profilePic')
        .skip(skip)
        .limit(parseInt(limit));

    const totalResults = await Story.countDocuments(filter);

    return {
        results: stories,
        page: parseInt(page),
        limit: parseInt(limit),
        totalResults
    };
};

/**
 * Get active unexpired stories for students
 */
const getActiveStudentStories = async (libraryId) => {
    const now = new Date();
    return await Story.find({
        libraryId,
        isActive: true,
        expiresAt: { $gt: now }
    }).sort({ createdAt: -1 });
};

/**
 * Get story by ID
 */
const getStoryById = async (id) => {
    return await Story.findById(id)
        .populate('viewedBy.studentId', 'name profilePic')
        .populate('likedBy', 'name profilePic')
        .populate('repliesData.studentId', 'name profilePic');
};

/**
 * Update story
 */
const updateStory = async (id, updateBody) => {
    return await Story.findByIdAndUpdate(
        id,
        { $set: updateBody },
        { new: true }
    );
};

/**
 * Delete story
 */
const deleteStory = async (id) => {
    return await Story.findByIdAndDelete(id);
};

/**
 * Increment view counts
 */
const incrementViews = async (id, studentId) => {
    if (!studentId) return await Story.findById(id);

    const story = await Story.findById(id);
    if (!story) return null;

    const hasViewed = story.viewedBy.some(v => v.studentId.toString() === studentId);

    if (!hasViewed) {
        return await Story.findByIdAndUpdate(
            id,
            { 
                $inc: { views: 1, uniqueViews: 1 },
                $push: { viewedBy: { studentId } }
            },
            { new: true }
        );
    }
    
    return story;
};

/**
 * Toggle like status
 */
const toggleLike = async (id, studentId) => {
    const story = await Story.findById(id);
    if (!story) return null;

    const isLiked = story.likedBy.includes(studentId);
    
    if (isLiked) {
        return await Story.findByIdAndUpdate(
            id,
            { $pull: { likedBy: studentId } },
            { new: true }
        );
    } else {
        const updatedStory = await Story.findByIdAndUpdate(
            id,
            { $addToSet: { likedBy: studentId } },
            { new: true }
        );

        // Send notification to the library admin
        if (story.createdBy) {
            const student = await Student.findById(studentId);
            if (student) {
                await Notification.create({
                    recipientId: story.createdBy,
                    recipientType: 'Admin',
                    libraryId: story.libraryId,
                    type: 'story_like',
                    title: 'New Story Like',
                    message: `${student.name} liked your story "${story.title || 'Untitled'}"`,
                    data: { storyId: story._id }
                });
            }
        }

        return updatedStory;
    }
};

/**
 * Add reply to story
 */
const addReply = async (id, studentId, message) => {
    const story = await Story.findById(id);
    if (!story) return null;

    const updatedStory = await Story.findByIdAndUpdate(
        id,
        { 
            $inc: { replies: 1 },
            $push: { 
                repliesData: { studentId, message } 
            }
        },
        { new: true }
    );

    // Send notification to the library admin
    if (story.createdBy) {
        const student = await Student.findById(studentId);
        if (student) {
            await Notification.create({
                recipientId: story.createdBy,
                recipientType: 'Admin',
                libraryId: story.libraryId,
                type: 'story_reply',
                title: 'New Story Comment',
                message: `${student.name} commented on your story: "${message}"`,
                data: { storyId: story._id }
            });
        }
    }

    return updatedStory;
};

module.exports = {
    createStory,
    queryStories,
    getActiveStudentStories,
    getStoryById,
    updateStory,
    deleteStory,
    incrementViews,
    toggleLike,
    addReply
};
