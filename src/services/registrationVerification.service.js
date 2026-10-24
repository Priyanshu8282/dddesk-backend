const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config/config');
const ApiError = require('../utils/ApiError');
const { normalizeMobile } = require('../utils/mobile');
const RegistrationOtp = require('../models/registrationOtp.model');

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const TOKEN_TTL = '30m';

const hash = (mobile, otp) => crypto.createHash('sha256').update(`reg:${mobile}:${otp}:${config.jwt.secret}`).digest('hex');

// Required when REQUIRE_REGISTRATION_OTP !== 'false' in production; default off elsewhere.
const isRequired = () => {
    const v = process.env.REQUIRE_REGISTRATION_OTP;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return process.env.NODE_ENV === 'production';
};

const sendOtp = async (rawMobile) => {
    const mobile = normalizeMobile(rawMobile);
    const otp = String(crypto.randomInt(100000, 1000000));
    await RegistrationOtp.findOneAndUpdate(
        { mobile },
        { $set: { otpHash: hash(mobile, otp), attempts: 0, expiresAt: new Date(Date.now() + OTP_TTL_MS) } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    try {
        await require('./notification.service').deliverOtp({ channel: 'sms', to: mobile, otp, purpose: 'registration' });
    } catch (_) { /* delivery failure is not surfaced */ }
    return { otp, isDev: String(process.env.OTP_IN_RESPONSE || '').toLowerCase() === 'true' && process.env.NODE_ENV !== 'production' };
};

const verifyOtp = async (rawMobile, otp) => {
    const mobile = normalizeMobile(rawMobile);
    const rec = await RegistrationOtp.findOne({ mobile });
    if (!rec || rec.expiresAt.getTime() < Date.now()) throw new ApiError(400, 'OTP expired or not requested. Please request a new one.');
    // Reserve the attempt atomically so parallel guesses cannot exceed MAX_ATTEMPTS
    const reserved = await RegistrationOtp.findOneAndUpdate(
        { _id: rec._id, attempts: { $lt: MAX_ATTEMPTS } },
        { $inc: { attempts: 1 } },
        { new: true }
    );
    if (!reserved) {
        await RegistrationOtp.deleteOne({ _id: rec._id });
        throw new ApiError(429, 'Too many incorrect attempts. Please request a new OTP.');
    }
    const a = Buffer.from(hash(mobile, String(otp)), 'hex');
    const b = Buffer.from(rec.otpHash, 'hex');
    if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) throw new ApiError(400, 'Invalid OTP');
    await RegistrationOtp.deleteOne({ _id: rec._id });
    const registrationToken = jwt.sign({ purpose: 'register', mobile }, config.jwt.secret, { expiresIn: TOKEN_TTL });
    return { registrationToken };
};

// Throws 400/403 unless verification is satisfied (or not required)
const assertRegistrationToken = (token, rawMobile) => {
    if (!isRequired()) return;
    if (!token) throw new ApiError(403, 'Mobile verification is required. Please verify your mobile number first.');
    let payload;
    try { payload = jwt.verify(String(token), config.jwt.secret); }
    catch (_) { throw new ApiError(403, 'Mobile verification expired. Please verify your mobile number again.'); }
    if (payload.purpose !== 'register' || payload.mobile !== normalizeMobile(rawMobile)) {
        throw new ApiError(403, 'Verified mobile number does not match the registration mobile.');
    }
};

// Always-on variant for the wizard (draft/complete): returns the verified mobile or throws 403 TOKEN_INVALID
const mobileFromToken = (token) => {
    const bad = (m) => Object.assign(new ApiError(403, m), { errorCode: 'TOKEN_INVALID' });
    if (!token) throw bad('Mobile verification is required. Please verify your mobile number first.');
    let payload;
    try { payload = jwt.verify(String(token), config.jwt.secret); }
    catch (_) { throw bad('Mobile verification expired. Please verify your mobile number again.'); }
    if (payload.purpose !== 'register' || !payload.mobile) throw bad('Invalid verification token.');
    return payload.mobile;
};

module.exports = { sendOtp, verifyOtp, assertRegistrationToken, mobileFromToken, isRequired };
