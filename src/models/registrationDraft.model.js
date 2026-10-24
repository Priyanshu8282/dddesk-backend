const mongoose = require('mongoose');

// Self-registration progress, keyed by the OTP-verified mobile. Nothing here touches Library/Admin until
// POST /v1/public/register/complete succeeds. Only allow-listed fields are ever stored (never a password or Aadhaar).
const DATA_FIELDS = ['name', 'ownerName', 'email', 'address', 'city', 'state', 'district', 'pincode', 'country',
    'seatCapacity', 'workingHours', 'facilities', 'alternativeMobileNumber', 'website', 'gstNumber', 'description'];

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_TTL_MS = 60 * 60 * 1000;

const registrationDraftSchema = new mongoose.Schema({
    mobile: { type: String, required: true, unique: true },
    status: { type: String, enum: ['draft', 'completing', 'completed'], default: 'draft', index: true },
    step: { type: Number, min: 1, max: 4, default: 1 },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlatformPlan', default: null },
    billingCycle: { type: String, enum: ['monthly', 'annual'], default: 'monthly' },
    data: {
        name: { type: String, default: '' }, ownerName: { type: String, default: '' }, email: { type: String, default: '' },
        address: { type: String, default: '' }, city: { type: String, default: '' }, state: { type: String, default: '' },
        district: { type: String, default: '' }, pincode: { type: String, default: '' }, country: { type: String, default: 'India' },
        seatCapacity: { type: Number, default: null },
        workingHours: {
            openingTime: { type: String, default: '' }, closingTime: { type: String, default: '' },
            weeklyHoliday: { type: String, default: '' }, openDays: { type: String, default: '' },
        },
        facilities: { type: [String], default: [] },
        alternativeMobileNumber: { type: String, default: '' }, website: { type: String, default: '' },
        gstNumber: { type: String, default: '' }, description: { type: String, default: '' },
    },
    consent: {
        terms: { type: Boolean, default: false }, privacy: { type: Boolean, default: false }, marketing: { type: Boolean, default: false },
        version: { type: String, default: null }, at: { type: Date, default: null }, ip: { type: String, default: null },
    },
    // idempotency + race guard for /complete
    completeKey: { type: String, default: null },
    completingAt: { type: Date, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
}, { timestamps: true });

registrationDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RegistrationDraft || mongoose.model('RegistrationDraft', registrationDraftSchema);
module.exports.DATA_FIELDS = DATA_FIELDS;
module.exports.DRAFT_TTL_MS = DRAFT_TTL_MS;
module.exports.DONE_TTL_MS = DONE_TTL_MS;
