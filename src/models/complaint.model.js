const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema({
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        required: true,
        index: true
    },
    branchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        default: null
    },
    ticketId: {
        type: String,
        unique: true,
        index: true
    },
    title: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        required: true,
        trim: true
    },
    category: {
        type: String,
        enum: [
            'ac',
            'fan',
            'light',
            'wifi',
            'chair',
            'table',
            'charging',
            'washroom',
            'cleanliness',
            'noise',
            'water',
            'other'
        ],
        default: 'other',
        index: true
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high', 'urgent'],
        default: 'medium',
        index: true
    },
    status: {
        type: String,
        enum: ['open', 'assigned', 'in_progress', 'resolved', 'closed'],
        default: 'open',
        index: true
    },
    studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
        default: null,
        index: true
    },
    seatNumber: {
        type: String,
        trim: true,
        default: null
    },
    seatId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Seat',
        default: null
    },
    // Location label for rooms / common areas (used with seatNumber to spot recurring faults)
    room: {
        type: String,
        trim: true,
        default: null
    },
    images: [{
        type: String
    }],
    videos: [{
        type: String
    }],
    statusHistory: [{
        from: String,
        to: String,
        by: { type: mongoose.Schema.Types.ObjectId },
        at: { type: Date, default: Date.now },
        _id: false
    }],
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
        default: null
    },
    assignedAt: {
        type: Date
    },
    assignedNotes: {
        type: String,
        trim: true
    },
    resolutionNote: {
        type: String,
        trim: true
    },
    resolvedAt: {
        type: Date
    },
    resolvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin'
    },
    closedAt: {
        type: Date
    },
    closedBy: {
        type: mongoose.Schema.Types.ObjectId
    },
    notes: [{
        author: {
            type: mongoose.Schema.Types.ObjectId
        },
        authorModel: {
            type: String,
            enum: ['Admin', 'Student'],
            default: 'Admin'
        },
        authorName: {
            type: String
        },
        message: {
            type: String,
            required: true
        },
        // Internal staff notes are never shown to students
        isInternal: {
            type: Boolean,
            default: false
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    cost: {
        type: Number,
        default: 0
    },
    expenseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Expense',
        default: null
    },
    createdByModel: {
        type: String,
        enum: ['Admin', 'Student'],
        default: 'Student'
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    }
}, {
    timestamps: true
});

// Auto-generate human-friendly ticket ID (e.g., TKT-2610-A9F3)
complaintSchema.pre('save', function () {
    if (!this.ticketId) {
        const crypto = require('crypto');
        const date = new Date();
        const yearShort = date.getFullYear().toString().slice(-2);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        this.ticketId = `TKT-${yearShort}${month}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    }
});

// Automatically filter out soft-deleted complaints
complaintSchema.pre(['find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne'], function () {
    if (this.getFilter().isDeleted === undefined) this.where({ isDeleted: false });
});
complaintSchema.index({ libraryId: 1, category: 1, createdAt: -1 });
complaintSchema.index({ libraryId: 1, studentId: 1, createdAt: -1 });

module.exports = mongoose.model('Complaint', complaintSchema);
