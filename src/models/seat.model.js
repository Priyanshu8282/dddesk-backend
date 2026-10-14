const mongoose = require('mongoose');

const seatSchema = new mongoose.Schema({
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        required: true,
        index: true
    },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    seatNumber: {
        type: String,
        required: true,
        trim: true
    },
    floor: {
        type: String,
        trim: true,
        default: 'Ground Floor'
    },
    room: {
        type: String,
        trim: true,
        default: 'Main Hall'
    },
    type: {
        type: String,
        enum: ['standard', 'premium', 'window', 'ac', 'non-ac', 'custom'],
        default: 'standard'
    },
    customType: {
        type: String,
        trim: true
    },
    status: {
        type: String,
        enum: ['available', 'occupied', 'reserved', 'blocked', 'maintenance'],
        default: 'available',
        index: true
    },
    price: {
        type: Number,
        default: 0
    },
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        default: null
    },
    assignedAt: {
        type: Date,
        default: null
    },
    // Temporary reservation (auto-expires via cron)
    reservedFor: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    reservedUntil: { type: Date, default: null },
    reservedReason: { type: String, trim: true },
    // Reason for blocked / maintenance status
    blockedReason: {
        type: String,
        trim: true
    },
    isDeleted: {
        type: Boolean,
        default: false
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin'
    }
}, { timestamps: true });

// Unique seat number per library
// (partial: a soft-deleted seat's number can be reused)
seatSchema.index(
    { libraryId: 1, seatNumber: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false }, name: 'uniq_library_seat_active' }
);
seatSchema.index({ libraryId: 1, studentId: 1 });

// Soft delete filter
seatSchema.pre(['find', 'findOne', 'countDocuments'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('Seat', seatSchema);
