const mongoose = require('mongoose');

const NOTICE_TYPES = ['holiday', 'timing-change', 'fee-reminder', 'exam', 'maintenance', 'emergency', 'important', 'general', 'fees'];
// 'specific' and 'premium' are legacy values kept so old documents stay valid
const AUDIENCES = ['all', 'selected', 'branch', 'membershipGroup', 'specific', 'premium'];

const noticeSchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true },
    // null = all branches; otherwise the notice belongs to one branch
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 3000 },
    type: { type: String, enum: NOTICE_TYPES, default: 'general' },
    imageUrl: { type: String }, // Optional notice image attachment path

    // Audience
    sendTo: { type: String, enum: AUDIENCES, default: 'all' },
    targetStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }], // sendTo = selected
    targetBranchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }], // sendTo = branch
    targetPlanIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Plan' }],     // sendTo = membershipGroup

    // Schedule: visible while startDate <= now < endDate (endDate optional)
    startDate: { type: Date, default: Date.now },
    endDate: { type: Date, default: null },
    publishDate: { type: Date, default: Date.now }, // legacy mirror of startDate

    // Public audience: show on the library's public website (default: students only)
    showOnWebsite: { type: Boolean, default: false },

    isPinned: { type: Boolean, default: false },
    views: { type: Number, default: 0 },
    seenBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }], // unique views
    // isActive == published. Unpublished notices are drafts hidden from students.
    isActive: { type: Boolean, default: true },
    publishedAt: { type: Date },
    notifiedAt: { type: Date, default: null }, // delivery done (guards scheduled publishing)
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

noticeSchema.index({ libraryId: 1, isActive: 1, isPinned: -1, createdAt: -1 });
noticeSchema.index({ libraryId: 1, startDate: 1, endDate: 1 });

noticeSchema.statics.TYPES = NOTICE_TYPES;

module.exports = mongoose.model('Notice', noticeSchema);
