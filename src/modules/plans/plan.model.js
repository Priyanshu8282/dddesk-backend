const mongoose = require('mongoose');

const libraryPlanSchema = new mongoose.Schema({
    libraryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Library',
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: { type: String },

    // Duration type as per DDdesk spec
    durationType: {
        type: String,
        enum: ['daily', 'weekly', 'monthly', 'quarterly', 'half-yearly', 'yearly', 'custom'],
        required: true,
        default: 'monthly'
    },
    // Number of days for 'custom'; auto-filled for standard types
    durationDays: {
        type: Number
    },

    // Pricing
    price: { type: Number, required: true },
    discount: { type: Number, default: 0 },  // flat ₹ discount
    finalPrice: { type: Number },

    // Optional extras
    depositAmount: { type: Number, default: 0 },
    joiningFee: { type: Number, default: 0 },

    // Features (e.g. "AC Room", "WiFi", "Locker")
    features: [{ type: String }],

    // Seat eligibility
    seatTypes: [{
        type: String,
        enum: ['standard', 'premium', 'window', 'ac', 'non-ac', 'custom', 'all']
    }],

    status: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

const DURATION_DAYS = {
    daily: 1,
    weekly: 7,
    monthly: 30,
    quarterly: 90,
    'half-yearly': 180,
    yearly: 365
};

libraryPlanSchema.pre('save', function () {
    // Auto-set durationDays for standard types
    if (this.durationType !== 'custom') {
        this.durationDays = DURATION_DAYS[this.durationType];
    }
    // Calculate final price
    this.finalPrice = Math.max(0, this.price - (this.discount || 0));
});

libraryPlanSchema.pre(['find', 'findOne'], function () {
    this.where({ isDeleted: false });
});

module.exports = mongoose.model('Plan', libraryPlanSchema);
