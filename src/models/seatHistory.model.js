const mongoose = require('mongoose');

const seatHistorySchema = new mongoose.Schema({
    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    seatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seat', required: true, index: true },
    seatNumber: { type: String },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    action: {
        type: String,
        enum: ['assigned', 'released', 'auto_released', 'transfer_in', 'transfer_out', 'reserved',
            'reservation_cancelled', 'reservation_expired', 'blocked', 'maintenance', 'unblocked'],
        required: true
    },
    relatedSeatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seat', default: null },
    reason: { type: String, trim: true },
    performedBy: { type: mongoose.Schema.Types.ObjectId },
    performedByType: { type: String, default: 'system' },
    at: { type: Date, default: Date.now }
}, { timestamps: false });

seatHistorySchema.index({ seatId: 1, at: -1 });

module.exports = mongoose.models.SeatHistory || mongoose.model('SeatHistory', seatHistorySchema);
