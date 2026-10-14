const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        required: true,
        index: true
    },
    title: {
        type: String,
        required: true,
        trim: true
    },
    code: {
        type: String,
        required: true,
        trim: true,
        uppercase: true
    },
    description: {
        type: String,
        trim: true
    },
    discountType: {
        type: String,
        enum: ['flat', 'percentage'],
        required: true,
        default: 'flat'
    },
    discountValue: {
        type: Number,
        required: true,
        min: 1
    },
    maxDiscountAmount: {
        type: Number,
        default: null // Cap for percentage discount (e.g., 20% off up to ₹500)
    },
    minOrderAmount: {
        type: Number,
        default: 0 // Minimum fee amount required to apply coupon
    },
    applicablePlans: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Plan'
    }], // Empty array means applicable to all plans
    offerType: {
        type: String,
        enum: ['general', 'new_student', 'referral', 'festival', 'first_month', 'limited_seat'],
        default: 'general'
    },
    startDate: {
        type: Date,
        default: Date.now
    },
    endDate: {
        type: Date,
        required: true
    },
    usageLimit: {
        type: Number,
        default: null // Total usage limit across library (null = unlimited)
    },
    usageCount: {
        type: Number,
        default: 0
    },
    perStudentLimit: {
        type: Number,
        default: 1 // Max times a single student can use this coupon
    },
    usedBy: [{
        studentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Student'
        },
        usedAt: {
            type: Date,
            default: Date.now
        },
        paymentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Payment',
            default: null
        },
        discountApplied: {
            type: Number,
            default: 0
        }
    }],
    // Show this offer on the public library website
    showOnWebsite: {
        type: Boolean,
        default: false
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true
    },
    isDeleted: {
        type: Boolean,
        default: false,
        index: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin'
    }
}, {
    timestamps: true
});

// Coupon code is unique per library among non-deleted coupons
couponSchema.index({ libraryId: 1, code: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });

// Soft-delete query filter
couponSchema.pre(['find', 'findOne', 'countDocuments'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('Coupon', couponSchema);
