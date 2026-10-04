const mongoose = require('mongoose');

const platformPlanSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, default: '' },
    monthlyPrice: { type: Number, required: true, default: 0 },
    annualPrice: { type: Number, default: 0 },
    trialDays: { type: Number, default: 14 },
    graceDays: { type: Number, default: 7 },
    // Feature entitlements
    maxStudents: { type: Number, default: 100 },
    maxSeats: { type: Number, default: 50 },
    maxStaff: { type: Number, default: 3 },
    features: [{ type: String }],
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, { timestamps: true });

module.exports = mongoose.model('PlatformPlan', platformPlanSchema);
