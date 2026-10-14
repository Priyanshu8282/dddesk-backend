const mongoose = require('mongoose');

const noticeSchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    type: { type: String, enum: ['important', 'general', 'holiday', 'fees'], default: 'general' },
    imageUrl: { type: String }, // Optional notice image attachment path
    sendTo: { type: String, enum: ['all', 'premium', 'specific'], default: 'all' },
    publishDate: { type: Date, default: Date.now },
    isPinned: { type: Boolean, default: false },
    views: { type: Number, default: 0 },
    seenBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }], // For tracking unique views
    targetStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }], // For targeting specific students
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

// Indexes for query performance
noticeSchema.index({ libraryId: 1, isActive: 1, isPinned: -1, createdAt: -1 });

module.exports = mongoose.model('Notice', noticeSchema);
