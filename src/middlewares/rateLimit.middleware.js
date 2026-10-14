const rateLimit = require('express-rate-limit');

const { ipKeyGenerator } = rateLimit;

// NOTE: limiters key on req.ip. Behind a proxy/load balancer app.set('trust proxy', 1)
// must be configured (it is in app.js) or every client shares the proxy's IP.
const make = (windowMs, limit, message, extra = {}) =>
    rateLimit({
        windowMs,
        limit,
        message: { success: false, code: 429, message },
        standardHeaders: true,
        legacyHeaders: false,
        ...extra
    });

const loginLimiter = make(15 * 60 * 1000, 10, 'Too many login attempts. Please try again after 15 minutes.');
const otpLimiter = make(10 * 60 * 1000, 5, 'Too many OTP requests. Please try again after 10 minutes.');
const generalLimiter = make(60 * 1000, 100, 'Too many requests. Please slow down.');

// Library owner registration: few per hour per IP
const registerLimiter = make(60 * 60 * 1000, 5, 'Too many registration attempts. Please try again later.');
// Public enquiry form: spam protection
const enquiryLimiter = make(60 * 60 * 1000, 8, 'Too many enquiries submitted. Please try again later.');
// Student login: only failed attempts count, so a legitimate user is never locked out by success
const studentLoginLimiter = make(15 * 60 * 1000, 10, 'Too many login attempts. Please try again after 15 minutes.', {
    skipSuccessfulRequests: true
});
// AI assistant: protects the paid upstream API
const aiLimiter = make(60 * 1000, 15, 'Too many AI requests. Please wait a moment.');
// Review submission: per logged-in student (falls back to IP)
const reviewLimiter = make(60 * 60 * 1000, 5, 'Too many reviews submitted. Please try again later.', {
    keyGenerator: (req) => (req.user && req.user._id ? 'u:' + String(req.user._id) : ipKeyGenerator(req.ip))
});

module.exports = {
    loginLimiter, otpLimiter, generalLimiter,
    registerLimiter, enquiryLimiter, studentLoginLimiter, aiLimiter, reviewLimiter
};
