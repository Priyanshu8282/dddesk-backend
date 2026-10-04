const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: { success: false, message: 'Too many login attempts. Please try again after 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 5,
    message: { success: false, message: 'Too many OTP requests. Please try again after 10 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const generalLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    message: { success: false, message: 'Too many requests. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = { loginLimiter, otpLimiter, generalLimiter };
