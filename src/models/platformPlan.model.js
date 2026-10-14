const mongoose = require('mongoose');

const platformPlanSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, default: '' },
    monthlyPrice: { type: Number, required: true, default: 0, min: 0 },
    annualPrice: { type: Number, default: 0, min: 0 },
    trialDays: { type: Number, default: 14, min: 0 },
    graceDays: { type: Number, default: 7, min: 0 },
    // Feature entitlements
    maxStudents: { type: Number, default: 100, min: 0 },
    maxSeats: { type: Number, default: 50, min: 0 },
    maxStaff: { type: Number, default: 3, min: 0 },
    maxBranches: { type: Number, default: 0, min: 0 }, // 0 = unlimited
    features: [{ type: String }],
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

module.exports = mongoose.model('PlatformPlan', platformPlanSchema);
