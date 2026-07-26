const Notice = require('./notice.model');

/**
 * Create a new Notice
 */
const createNotice = async (noticeData, creatorInfo) => {
    return await Notice.create({
        ...noticeData,
        createdBy: creatorInfo?.id
    });
};

/**
 * Query notices for administrative paginated list
 */
const queryNotices = async (filter, options = {}) => {
    const { page = 1, limit = 100 } = options;
    const skip = (page - 1) * limit;

    const notices = await Notice.find(filter)
        .sort({ isPinned: -1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

    const totalResults = await Notice.countDocuments(filter);

    return {
        results: notices,
        page: parseInt(page),
        limit: parseInt(limit),
        totalResults
    };
};

/**
 * Get active notices for students based on segment target
 */
const getActiveStudentNotices = async (libraryId, studentId, isPremium) => {
    const now = new Date();
    
    // Filter by library, active status, and target audience
    const filter = {
        libraryId,
        isActive: true,
        publishDate: { $lte: now },
        $or: [
            { sendTo: 'all' }
        ]
    };

    if (isPremium) {
        filter.$or.push({ sendTo: 'premium' });
    }

    // Include specific targeted notices
    if (studentId) {
        filter.$or.push({ sendTo: 'specific', targetStudents: studentId });
    }

    return await Notice.find(filter).sort({ isPinned: -1, createdAt: -1 });
};

/**
 * Get notice by ID
 */
const getNoticeById = async (id) => {
    return await Notice.findById(id).populate('targetStudents', 'name email mobile');
};

/**
 * Update notice details
 */
const updateNotice = async (id, updateBody) => {
    return await Notice.findByIdAndUpdate(
        id,
        { $set: updateBody },
        { new: true }
    );
};

/**
 * Delete notice
 */
const deleteNotice = async (id) => {
    return await Notice.findByIdAndDelete(id);
};

/**
 * Increment unique views and track student views
 */
const incrementViews = async (id, studentId) => {
    const update = { $inc: { views: 1 } };
    
    if (studentId) {
        update.$addToSet = { seenBy: studentId };
    }

    return await Notice.findByIdAndUpdate(
        id,
        update,
        { new: true }
    );
};

module.exports = {
    createNotice,
    queryNotices,
    getActiveStudentNotices,
    getNoticeById,
    updateNotice,
    deleteNotice,
    incrementViews
};
