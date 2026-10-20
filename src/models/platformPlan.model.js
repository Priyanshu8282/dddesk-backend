const mongoose = require('mongoose');

const platformPlanSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    description: { type: String, default: '' },
    monthlyPrice: { type: Number, required: true, default: 0, min: 0 },
    annualPrice: { type: Number, default: 0, min: 0 },
    // Prices are EXCLUDING GST (Indian SaaS practice); GST is added at checkout and shown on the invoice
    gstPercent: { type: Number, default: 18, min: 0, max: 28 },
    isPopular: { type: Boolean, default: false },      // "Most popular" ribbon on the pricing cards
    sortOrder: { type: Number, default: 0 },           // lower = shown first (ties: cheaper first)
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
