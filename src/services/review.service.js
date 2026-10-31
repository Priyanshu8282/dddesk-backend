const mongoose = require('mongoose');
const crypto = require('crypto');
const Review = require('../models/review.model');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');

const SPAM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const EDIT_COOLDOWN_MS = 60 * 1000;

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const assertId = (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid review ID');
};

const hashText = (text) =>
    crypto.createHash('sha1').update(String(text).toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim()).digest('hex');

// Looks like keyboard mashing / one repeated character
const looksLikeSpam = (text) => {
    const t = String(text).replace(/\s+/g, '');
    if (!t.length) return true;
    if (/(.)\1{9,}/.test(t)) return true;
    return new Set(t.toLowerCase()).size < 4;
};

/**
 * Submit (or edit) the student's review. One live review per student per library per type.
 * Editing sends it back to moderation.
 */
exports.submitReview = async (student, libraryId, data) => {
    if (!student || !student._id) throw new ApiError(401, 'Student identity required to submit review');

    const type = data.type === 'internal' ? 'internal' : 'public';
    const text = String(data.review).trim();
    if (looksLikeSpam(text)) throw new ApiError(400, 'Please write a meaningful review');

    const textHash = hashText(text);
    const existing = await Review.findOne({ libraryId, studentId: student._id, type }).select('+textHash');

    // Same text already posted by another student recently => copy/paste spam
    const duplicate = await Review.exists({
        libraryId, type, textHash, studentId: { $ne: student._id },
        createdAt: { $gte: new Date(Date.now() - SPAM_WINDOW_MS) }
    });
    if (duplicate) throw new ApiError(409, 'This review looks like a duplicate of an existing one');

    if (existing) {
        if (existing.textHash === textHash && existing.rating === data.rating) {
            throw new ApiError(409, 'You have already submitted this review');
        }
        if (Date.now() - new Date(existing.updatedAt).getTime() < EDIT_COOLDOWN_MS) {
            throw new ApiError(429, 'Please wait a moment before editing your review again');
        }
        existing.rating = data.rating;
        existing.review = text;
        existing.textHash = textHash;
        if (data.isAnonymous !== undefined) existing.isAnonymous = data.isAnonymous;
        if (data.aspects) existing.aspects = data.aspects;
        existing.status = 'pending'; // re-approval required after an edit
        existing.isFeatured = false;
        await existing.save();
        return existing;
    }

    try {
        return await Review.create({
            libraryId, studentId: student._id, studentName: student.name || 'Student', type,
            rating: data.rating, review: text, textHash, isAnonymous: !!data.isAnonymous,
            aspects: data.aspects, status: 'pending'
        });
    } catch (e) {
        if (e.code === 11000) throw new ApiError(409, 'You have already submitted a review');
        throw e;
    }
};

// Admin list. Contact details are only ever returned to staff (route is staff-only).
exports.listReviews = async (libraryId, query = {}) => {
    const filter = { libraryId };
    if (query.status && query.status !== 'all') filter.status = query.status;
    if (query.type) filter.type = query.type;
    if (query.rating) filter.rating = Number(query.rating);
    if (query.isFeatured !== undefined) filter.isFeatured = query.isFeatured === true || query.isFeatured === 'true';
    if (query.search && String(query.search).trim()) {
        const rx = new RegExp(escapeRegex(String(query.search).trim()), 'i');
        filter.$or = [{ review: rx }, { studentName: rx, isAnonymous: false }]; // an anonymous review is not found by name
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const [data, total] = await Promise.all([
        Review.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
            .populate('studentId', 'name mobile email rollNumber profileImage')
            .populate('ownerReply.repliedBy', 'name'),
        Review.countDocuments(filter)
    ]);
    return { data, total, page, totalPages: Math.ceil(total / limit), limit };
};

/**
 * Approved public reviews for the library website (only when the website shows reviews).
 * Never exposes student ids or contact data.
 */
exports.getPublicReviews = async (libraryId) => {
    const LibraryWebsite = require('../models/libraryWebsite.model');
    const site = await LibraryWebsite.findOne({ libraryId }).select('showReviews').lean();
    if (site && site.showReviews === false) {
        return { summary: { averageRating: 0, totalReviews: 0, ratingDistribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }, aspectAverages: {} }, reviews: [] };
    }

    const reviews = await Review.find({ libraryId, status: 'approved', type: 'public' })
        .sort({ isFeatured: -1, rating: -1, createdAt: -1 }).limit(100)
        .populate('studentId', 'name profileImage');

    let sumRating = 0;
    const distribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    const aspectKeys = ['cleanliness', 'wifi', 'comfort', 'ambience', 'staff'];
    const aspectSums = {}; const aspectCounts = {};
    aspectKeys.forEach((k) => { aspectSums[k] = 0; aspectCounts[k] = 0; });

    const sanitized = reviews.map((r) => {
        sumRating += r.rating;
        const star = Math.min(5, Math.max(1, Math.floor(r.rating)));
        distribution[star] += 1;
        aspectKeys.forEach((k) => { if (r.aspects && r.aspects[k]) { aspectSums[k] += r.aspects[k]; aspectCounts[k] += 1; } });
        return {
            _id: r._id,
            rating: r.rating,
            review: r.review,
            aspects: r.aspects,
            isFeatured: r.isFeatured,
            authorName: r.isAnonymous ? 'Verified Member' : (r.studentId?.name || r.studentName || 'Member'),
            authorImage: r.isAnonymous ? null : (r.studentId?.profileImage || null),
            ownerReply: r.ownerReply?.text ? { text: r.ownerReply.text, repliedAt: r.ownerReply.repliedAt } : null,
            createdAt: r.createdAt
        };
    });

    const totalCount = reviews.length;
    const aspectAverages = {};
    aspectKeys.forEach((k) => {
        aspectAverages[k] = aspectCounts[k] > 0 ? Math.round((aspectSums[k] / aspectCounts[k]) * 10) / 10 : null;
    });
    return {
        summary: {
            averageRating: totalCount > 0 ? Math.round((sumRating / totalCount) * 10) / 10 : 0,
            totalReviews: totalCount, ratingDistribution: distribution, aspectAverages
        },
        reviews: sanitized
    };
};

// Student's own reviews (public + internal)
exports.getMyReview = async (studentId, libraryId) =>
    Review.find({ studentId, libraryId }).populate('ownerReply.repliedBy', 'name').sort({ createdAt: -1 });

exports.getReviewById = async (id, libraryId) => {
    assertId(id);
    const review = await Review.findOne({ _id: id, libraryId })
        .populate('studentId', 'name mobile email rollNumber profileImage')
        .populate('ownerReply.repliedBy', 'name');
    if (!review) throw new ApiError(404, 'Review not found');
    return review;
};

exports.updateReviewStatus = async (id, libraryId, status, isFeatured, adminUser) => {
    assertId(id);
    const review = await Review.findOne({ _id: id, libraryId });
    if (!review) throw new ApiError(404, 'Review not found');

    if (review.type === 'internal' && (status === 'approved' || isFeatured === true)) {
        throw new ApiError(400, 'Internal feedback cannot be published on the website');
    }
    const nextStatus = status || review.status;
    if (isFeatured === true && nextStatus !== 'approved') {
        throw new ApiError(400, 'Only approved reviews can be featured');
    }
    if (status) {
        review.status = status;
        if (status !== 'approved') review.isFeatured = false;
    }
    if (isFeatured !== undefined) review.isFeatured = isFeatured;
    review.moderatedBy = adminUser._id;
    review.moderatedAt = new Date();
    await review.save();
    return exports.getReviewById(id, libraryId);
};

exports.replyToReview = async (id, libraryId, replyText, adminUser) => {
    assertId(id);
    const review = await Review.findOne({ _id: id, libraryId });
    if (!review) throw new ApiError(404, 'Review not found');
    review.ownerReply = { text: replyText, repliedBy: adminUser._id, repliedAt: new Date() };
    await review.save();
    return exports.getReviewById(id, libraryId);
};

exports.deleteReview = async (id, libraryId, user) => {
    assertId(id);
    const filter = { _id: id, libraryId };
    if (user.userType === 'student') filter.studentId = user._id; // students can only remove their own
    const res = await Review.findOneAndUpdate(filter, { $set: { isDeleted: true, isFeatured: false } });
    if (!res) throw new ApiError(404, 'Review not found');
    return true;
};

exports.getReviewStats = async (libraryId) => {
    const lib = oid(libraryId);
    const [counts, ratingAgg] = await Promise.all([
        Review.aggregate([
            { $match: { libraryId: lib, isDeleted: false } },
            { $group: { _id: { status: '$status', type: '$type' }, count: { $sum: 1 } } }
        ]),
        Review.aggregate([
            { $match: { libraryId: lib, isDeleted: false, status: 'approved', type: 'public' } },
            { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
        ])
    ]);

    const statusMap = { pending: 0, approved: 0, rejected: 0 };
    let total = 0; let internal = 0;
    counts.forEach((c) => {
        if (statusMap[c._id.status] !== undefined) statusMap[c._id.status] += c.count;
        if (c._id.type === 'internal') internal += c.count;
        total += c.count;
    });
    return {
        total, internal,
        pending: statusMap.pending, approved: statusMap.approved, rejected: statusMap.rejected,
        averageApprovedRating: ratingAgg[0]?.avgRating ? Math.round(ratingAgg[0].avgRating * 10) / 10 : 0
    };
};
