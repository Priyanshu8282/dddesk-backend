const mongoose = require('mongoose');

const membershipHistorySchema = new mongoose.Schema({
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true, index: true },
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
    planName: { type: String },
    price: { type: Number, default: 0 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, enum: ['active', 'expired', 'paused', 'cancelled'], default: 'active', index: true },
    seatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seat', default: null },
    source: { type: String, enum: ['assign', 'renewal', 'plan_change', 'manual'], default: 'assign' },
    // pause / extension tracking
    pausedAt: { type: Date },
    pauseReason: { type: String, trim: true },
    totalPausedDays: { type: Number, default: 0 },
    extensions: [{
        days: Number,
        reason: String,
        previousEndDate: Date,
        newEndDate: Date,
        by: { type: mongoose.Schema.Types.ObjectId },
        at: { type: Date, default: Date.now },
        _id: false
    }],
    closedReason: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId }
}, { timestamps: true });

membershipHistorySchema.index({ studentId: 1, startDate: -1 });

module.exports = mongoose.models.MembershipHistory || mongoose.model('MembershipHistory', membershipHistorySchema);
