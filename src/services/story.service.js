const mongoose = require('mongoose');
const Story = require('../models/story.model');
const Notification = require('../models/notification.model');
const Student = require('../models/student.model');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');
const pick = require('../utils/pick');
const { branchVisibility } = require('../utils/branchScope');

const HOUR = 60 * 60 * 1000;
const ARCHIVE_RETENTION_DAYS = 90;

const assertId = (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid story ID');
};

// What a student is allowed to see: live, not archived, inside its publish window
const liveFilter = (libraryId, now = new Date()) => ({
    libraryId,
    isActive: true,
    archived: { $ne: true },
    publishAt: { $lte: now },
    expiresAt: { $gt: now }
});

const statusOf = (s, now = new Date()) => {
    if (s.archived) return 'archived';
    if (new Date(s.expiresAt) <= now) return 'expired';
    if (new Date(s.publishAt) > now) return 'scheduled';
    return s.isActive ? 'active' : 'inactive';
};

/**
 * Create a story. `media` is the uploaded file (or null for text/offer stories).
 */
const createStory = async (libraryId, body, media, creatorId) => {
    let type = body.type;
    let url;
    if (media) {
        if (media.mediaKind !== 'image' && media.mediaKind !== 'video') {
            throw new ApiError(400, 'Stories accept images or videos only');
        }
        // type comes from the real file, except an image-backed offer
        type = type === 'offer' && media.mediaKind === 'image' ? 'offer' : media.mediaKind;
        url = media.path;
    } else {
        if (type !== 'text' && type !== 'offer') {
            throw new ApiError(400, 'A media file is required for image/video stories');
        }
        if (!body.textContent && !body.description) {
            throw new ApiError(400, 'Text content is required for text/offer stories');
        }
    }

    const publishAt = body.publishAt ? new Date(body.publishAt) : new Date();
    const hours = body.expiresInHours || 24;
    const expiresAt = new Date(publishAt.getTime() + hours * HOUR);
    if (expiresAt <= new Date()) throw new ApiError(400, 'Story would already be expired');

    return Story.create({
        ...pick(body, ['title', 'description', 'textContent', 'branchId']), // branchId validated by the controller (null = all branches)
        type, url, libraryId, publishAt, expiresAt, createdBy: creatorId
    });
};

/**
 * Staff list (without per-student arrays) + summary
 */
// `scope` = branch filter fragment from utils/branchScope.branchFilter(req): stories of those branches + all-branch stories
const queryStories = async (libraryId, { search, status, page = 1, limit = 10 } = {}, scope = {}) => {
    const now = new Date();
    const filter = { libraryId };
    if (search) {
        const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
        filter.$or = [{ title: rx }, { description: rx }];
    }
    if (status === 'archived') filter.archived = true;
    else if (status === 'expired') Object.assign(filter, { archived: { $ne: true }, expiresAt: { $lte: now } });
    else if (status === 'scheduled') Object.assign(filter, { archived: { $ne: true }, publishAt: { $gt: now } });
    else if (status === 'active') Object.assign(filter, liveFilter(libraryId, now));
    if (scope.branchId) filter.$and = [{ $or: [{ branchId: null }, scope] }];

    const p = Math.max(parseInt(page, 10) || 1, 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
    const [stories, totalResults, summary] = await Promise.all([
        Story.find(filter).select('-viewedBy -repliesData -likedBy').sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
        Story.countDocuments(filter),
        analytics(libraryId)
    ]);
    const results = stories.map((s) => ({ ...s, status: statusOf(s, now) }));
    return { results, page: p, limit: l, totalResults, summary };
};

const analytics = async (libraryId) => {
    const now = new Date();
    const past24h = new Date(Date.now() - 24 * HOUR);
    const lib = new mongoose.Types.ObjectId(String(libraryId));
    const [agg] = await Story.aggregate([
        { $match: { libraryId: lib } },
        { $group: {
            _id: null,
            totalStories: { $sum: 1 },
            totalViews: { $sum: '$views' },
            totalUniqueViews: { $sum: '$uniqueViews' },
            totalLikes: { $sum: { $size: { $ifNull: ['$likedBy', []] } } },
            totalReplies: { $sum: '$replies' },
            todayViews: { $sum: { $cond: [{ $gte: ['$createdAt', past24h] }, '$views', 0] } },
            totalActive: { $sum: { $cond: [{ $and: [
                { $eq: ['$isActive', true] }, { $ne: ['$archived', true] },
                { $lte: ['$publishAt', now] }, { $gt: ['$expiresAt', now] }
            ] }, 1, 0] } },
            totalScheduled: { $sum: { $cond: [{ $and: [{ $ne: ['$archived', true] }, { $gt: ['$publishAt', now] }] }, 1, 0] } }
        } }
    ]);
    return agg ? { ...agg, _id: undefined } : {
        totalStories: 0, totalViews: 0, totalUniqueViews: 0, totalLikes: 0, totalReplies: 0,
        todayViews: 0, totalActive: 0, totalScheduled: 0
    };
};

const topStories = (libraryId, n = 10) =>
    Story.find({ libraryId }).select('title type views uniqueViews replies likedBy createdAt expiresAt')
        .sort({ views: -1 }).limit(n).lean()
        .then((rows) => rows.map(({ likedBy, ...r }) => ({ ...r, likes: (likedBy || []).length })));

/**
 * Student feed: only live stories of the student's library. Hides other students' data.
 */
const getActiveStudentStories = async (libraryId, studentId, branchId = null) => {
    const stories = await Story.find({ ...liveFilter(libraryId), ...branchVisibility(branchId) }).sort({ publishAt: -1 }).lean();
    const sid = String(studentId);
    return stories.map((s) => ({
        _id: s._id, title: s.title, description: s.description, textContent: s.textContent, type: s.type,
        url: s.url, publishAt: s.publishAt, expiresAt: s.expiresAt, createdAt: s.createdAt,
        views: s.views, likes: (s.likedBy || []).length, replies: s.replies,
        viewed: (s.viewedBy || []).some((v) => String(v.studentId) === sid),
        liked: (s.likedBy || []).some((id) => String(id) === sid)
    }));
};

const getStoryById = async (id, libraryId) => {
    assertId(id);
    return Story.findOne({ _id: id, libraryId })
        .populate('viewedBy.studentId', 'name profileImage')
        .populate('likedBy', 'name profileImage')
        .populate('repliesData.studentId', 'name profileImage');
};

const updateStory = async (id, libraryId, body, media) => {
    assertId(id);
    const set = pick(body, ['title', 'description', 'textContent', 'isActive', 'branchId']);
    const existing = await Story.findOne({ _id: id, libraryId });
    if (!existing) return null;

    if (media) {
        if (media.mediaKind !== 'image' && media.mediaKind !== 'video') {
            throw new ApiError(400, 'Stories accept images or videos only');
        }
        set.url = media.path;
        set.type = existing.type === 'offer' && media.mediaKind === 'image' ? 'offer' : media.mediaKind;
    }
    if (body.publishAt) set.publishAt = new Date(body.publishAt);
    if (body.publishAt || body.expiresInHours) {
        const publishAt = set.publishAt || existing.publishAt;
        const hours = body.expiresInHours || Math.max(1, Math.round((existing.expiresAt - existing.publishAt) / HOUR));
        set.expiresAt = new Date(publishAt.getTime() + hours * HOUR);
        if (set.expiresAt > new Date()) { set.archived = false; set.archivedAt = undefined; } // re-opened
    }
    return Story.findOneAndUpdate({ _id: id, libraryId }, { $set: set }, { new: true, runValidators: true });
};

const toggleActive = async (id, libraryId) => {
    assertId(id);
    return Story.findOneAndUpdate({ _id: id, libraryId }, [{ $set: { isActive: { $not: '$isActive' } } }], { new: true });
};

const deleteStory = async (id, libraryId) => {
    assertId(id);
    return Story.findOneAndDelete({ _id: id, libraryId });
};

// ─── Student interactions (always tenant + liveness scoped) ──────────────────
const findLive = async (id, libraryId) => {
    assertId(id);
    const story = await Story.findOne({ _id: id, ...liveFilter(libraryId) }).select('_id title libraryId createdBy');
    if (!story) throw new ApiError(404, 'Story not found or no longer available');
    return story;
};

const incrementViews = async (id, libraryId, studentId) => {
    await findLive(id, libraryId);
    // Atomic: only the first view by this student counts
    await Story.updateOne(
        { _id: id, libraryId, 'viewedBy.studentId': { $ne: studentId } },
        { $inc: { views: 1, uniqueViews: 1 }, $push: { viewedBy: { studentId, viewedAt: new Date() } } }
    );
    return { viewed: true };
};

const toggleLike = async (id, libraryId, studentId) => {
    const story = await findLive(id, libraryId);
    const added = await Story.updateOne({ _id: id, libraryId, likedBy: { $ne: studentId } }, { $addToSet: { likedBy: studentId } });
    let liked = true;
    if (added.modifiedCount === 0) {
        await Story.updateOne({ _id: id, libraryId }, { $pull: { likedBy: studentId } });
        liked = false;
    } else if (story.createdBy) {
        const student = await Student.findOne({ _id: studentId, libraryId }).select('name');
        if (student) {
            Notification.create({
                recipientId: story.createdBy, recipientType: 'Admin', libraryId,
                type: 'story_like', title: 'New story like',
                message: `${student.name} liked your story "${story.title || 'Untitled'}"`,
                data: { storyId: String(story._id) }
            }).catch(() => {});
        }
    }
    const fresh = await Story.findById(id).select('likedBy').lean();
    return { liked, likes: (fresh?.likedBy || []).length };
};

const addReply = async (id, libraryId, studentId, message) => {
    const story = await findLive(id, libraryId);
    await Story.updateOne({ _id: id, libraryId }, { $inc: { replies: 1 }, $push: { repliesData: { studentId, message } } });
    if (story.createdBy) {
        const student = await Student.findOne({ _id: studentId, libraryId }).select('name');
        if (student) {
            Notification.create({
                recipientId: story.createdBy, recipientType: 'Admin', libraryId,
                type: 'story_reply', title: 'New story reply',
                message: `${student.name} replied to your story: "${message.slice(0, 100)}"`,
                data: { storyId: String(story._id) }
            }).catch(() => {});
        }
    }
    return { replied: true };
};

// ─── Publishing / lifecycle ──────────────────────────────────────────────────
const notifyPublished = async (story) => {
    try {
        const { notifyEvent } = require('./notification.service');
        const students = await Student.find({ libraryId: story.libraryId, status: 'active', isDeleted: false }).select('_id').lean();
        if (!students.length) return;
        const label = story.type === 'offer' ? 'New offer' : story.type === 'video' ? 'New video story' : 'New story';
        await notifyEvent('announcement', story.libraryId, {
            studentIds: students.map((s) => s._id),
            title: label,
            message: story.title || 'Check out the latest update from your library',
            data: { storyId: String(story._id), screen: 'stories' }
        });
    } catch (e) {
        console.error('Story notification failed:', e.message);
    }
};

// Marks the story as notified (atomic) then pushes. Safe to call twice.
const publishNotification = async (storyId) => {
    const story = await Story.findOneAndUpdate(
        { _id: storyId, notifiedAt: null, isActive: true, archived: { $ne: true } },
        { $set: { notifiedAt: new Date() } },
        { new: true }
    );
    if (story) await notifyPublished(story);
    return !!story;
};

// Cron hook (every few minutes): push scheduled stories that just went live.
const publishDueStories = async () => {
    const due = await Story.find({
        notifiedAt: null, isActive: true, archived: { $ne: true },
        publishAt: { $lte: new Date() }, expiresAt: { $gt: new Date() }
    }).select('_id').limit(200).lean();
    let n = 0;
    for (const s of due) if (await publishNotification(s._id)) n += 1;
    return n;
};

// Cron hook (hourly/daily): archive expired stories; purge archives past retention.
const archiveExpiredStories = async () => {
    const now = new Date();
    const archived = await Story.updateMany(
        { archived: { $ne: true }, expiresAt: { $lte: now } },
        { $set: { archived: true, archivedAt: now } }
    );
    const purgeBefore = new Date(Date.now() - ARCHIVE_RETENTION_DAYS * 24 * HOUR);
    const purged = await Story.deleteMany({ archived: true, archivedAt: { $lte: purgeBefore } });
    return { archived: archived.modifiedCount, purged: purged.deletedCount };
};

module.exports = {
    createStory, queryStories, analytics, topStories, getActiveStudentStories, getStoryById,
    updateStory, toggleActive, deleteStory, incrementViews, toggleLike, addReply,
    publishNotification, publishDueStories, archiveExpiredStories, statusOf
};
