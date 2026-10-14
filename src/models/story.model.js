const mongoose = require('mongoose');

const STORY_TYPES = ['image', 'video', 'text', 'offer'];

const storySchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true },
    // null = all branches
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 500 },
    // image/video are derived from the uploaded file; text/offer can be media-less
    type: { type: String, enum: STORY_TYPES, default: 'image' },
    textContent: { type: String, trim: true, maxlength: 500 },
    url: {
        type: String, // Path to the uploaded media file
        required: function () { return this.type === 'image' || this.type === 'video'; }
    },
    views: { type: Number, default: 0 },
    uniqueViews: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
    replies: { type: Number, default: 0 },
    repliesData: [{
        studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
        message: { type: String, required: true, maxlength: 300 },
        createdAt: { type: Date, default: Date.now }
    }],
    viewedBy: [{
        studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
        viewedAt: { type: Date, default: Date.now },
        _id: false
    }],
    isActive: { type: Boolean, default: true },
    // Visible to students when publishAt <= now < expiresAt
    publishAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    // Push notification sent for this story (guards scheduled publishing)
    notifiedAt: { type: Date, default: null },
    // Expired stories are archived (kept for analytics), not deleted
    archived: { type: Boolean, default: false },
    archivedAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

// Active-story queries
storySchema.index({ libraryId: 1, isActive: 1, archived: 1, publishAt: 1, expiresAt: 1 });
storySchema.index({ archived: 1, expiresAt: 1 });
// NOTE: no TTL index. Expired stories are archived by archiveExpiredStories(), never hard-deleted.

storySchema.statics.TYPES = STORY_TYPES;

module.exports = mongoose.model('Story', storySchema);
