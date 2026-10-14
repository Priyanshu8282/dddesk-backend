const mongoose = require('mongoose');

// Short-lived OTP used to verify a mobile number before public library registration (TTL cleanup)
const registrationOtpSchema = new mongoose.Schema({
    mobile: { type: String, required: true, unique: true },
    otpHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true }
}, { timestamps: true });

registrationOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RegistrationOtp || mongoose.model('RegistrationOtp', registrationOtpSchema);
