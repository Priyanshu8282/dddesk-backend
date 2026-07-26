const mongoose = require('mongoose');

const storySchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    type: { type: String, enum: ['image', 'video'], default: 'image' },
    url: { type: String, required: true }, // Path to the uploaded media file
    views: { type: Number, default: 0 },
    uniqueViews: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
    replies: { type: Number, default: 0 },
    repliesData: [{
        studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
        message: { type: String, required: true },
        createdAt: { type: Date, default: Date.now }
    }],
    viewedBy: [{
        studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
        viewedAt: { type: Date, default: Date.now }
    }],
    isActive: { type: Boolean, default: true },
    expiresAt: { type: Date, required: true }, // Stories expire after 24h
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

// Compound index for querying active, non-expired stories
storySchema.index({ libraryId: 1, isActive: 1, expiresAt: 1 });

// Automated index to remove expired stories from DB
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Story', storySchema);
