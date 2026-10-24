const rateLimit = require('express-rate-limit');
const securityLog = require('../utils/securityLog');
const MongoRateLimitStore = require('./rateLimitStore');

const { ipKeyGenerator } = rateLimit;

// NOTE: limiters key on req.ip. Behind a proxy/load balancer app.set('trust proxy', 1)
// must be configured (it is in app.js) or every client shares the proxy's IP.
//
// Store: counters are kept in MongoDB in production (serverless instances do not share memory) and in memory
// in development. Override with RATE_LIMIT_STORE=memory|mongo. If the store itself fails, requests are let through
// (fail-open, logged) so a database blip does not take the whole API down; the per-account lockout still applies.
const useMongo = () => {
    const v = String(process.env.RATE_LIMIT_STORE || '').toLowerCase();
    if (v === 'mongo') return true;
    if (v === 'memory') return false;
    return process.env.NODE_ENV === 'production';
};

let seq = 0;
const make = (windowMs, limit, message, extra = {}) => {
    const { name, ...rest } = extra;
    return rateLimit({
        windowMs,
        limit,
        message: { success: false, code: 429, message },
        standardHeaders: true,
        legacyHeaders: false,
        passOnStoreError: true,
        ...(useMongo() ? { store: new MongoRateLimitStore(name || `rl${++seq}`) } : {}),
        // every block is a security event (who, where, which endpoint), then the normal 429 answer
        handler: (req, res, next, options) => {
            securityLog.record(req, { type: 'rate_limited', outcome: 'blocked', reason: 'too_many_requests', meta: { limit, windowMs } });
            res.status(options.statusCode).json(options.message);
        },
        ...rest,
    });
};

/** Public factory for route files that need their own limiter (same store + logging as the shared ones). */
const limiter = ({ name, windowMs, limit, message = 'Too many requests. Please slow down.', keyGenerator, skipSuccessfulRequests }) =>
    make(windowMs, limit, message, { name, ...(keyGenerator ? { keyGenerator } : {}), ...(skipSuccessfulRequests ? { skipSuccessfulRequests } : {}) });

// What a client typed to identify an account (email / mobile), lower-cased: limits follow the ACCOUNT, not just the IP,
// so an attacker rotating through many IPs still hits one wall per target account.
const accountKey = (req) => {
    const b = req.body || {};
    const id = String(b.identifier || b.email || b.mobile || '').trim().toLowerCase().slice(0, 120);
    return id ? 'a:' + id : ipKeyGenerator(req.ip);
};
// Authenticated actions are limited per user (falls back to the IP)
const userKey = (req) => (req.user && req.user._id ? 'u:' + String(req.user._id) : ipKeyGenerator(req.ip));

const loginLimiter = make(15 * 60 * 1000, 10, 'Too many login attempts. Please try again after 15 minutes.', { name: 'login' });
const accountLoginLimiter = make(15 * 60 * 1000, 20, 'Too many attempts for this account. Please try again later.', { name: 'login-acct', keyGenerator: accountKey });
const otpLimiter = make(10 * 60 * 1000, 8, 'Too many OTP requests. Please try again after 10 minutes.', { name: 'otp' });
// One account can be sent at most a few codes (stops SMS/e-mail bombing of a victim from many IPs)
const accountOtpLimiter = make(10 * 60 * 1000, 5, 'Too many OTP requests for this account. Please try again after 10 minutes.', { name: 'otp-acct', keyGenerator: accountKey });
// Verifying has its own budget (the 5-attempt lock on the OTP itself is the real brute-force guard)
const otpVerifyLimiter = make(10 * 60 * 1000, 20, 'Too many OTP attempts. Please try again after 10 minutes.', { name: 'otp-verify' });
const accountOtpVerifyLimiter = make(10 * 60 * 1000, 12, 'Too many OTP attempts for this account. Please try again after 10 minutes.', { name: 'otp-verify-acct', keyGenerator: accountKey });
const generalLimiter = make(60 * 1000, 100, 'Too many requests. Please slow down.', { name: 'general' });
// Whole API, per client IP: generous, only stops floods and scrapers
const apiLimiter = make(60 * 1000, Number(process.env.API_RATE_LIMIT_PER_MIN || 600), 'Too many requests. Please slow down.', { name: 'api' });
// Cookie endpoints (refresh/logout)
const refreshLimiter = make(60 * 1000, 30, 'Too many requests. Please slow down.', { name: 'refresh' });

// Library owner registration: few per hour per IP
const registerLimiter = make(60 * 60 * 1000, 5, 'Too many registration attempts. Please try again later.', { name: 'register' });
// Public enquiry form: spam protection
const enquiryLimiter = make(60 * 60 * 1000, 8, 'Too many enquiries submitted. Please try again later.', { name: 'enquiry' });
// Student login: only failed attempts count, so a legitimate user is never locked out by success
const studentLoginLimiter = make(15 * 60 * 1000, 10, 'Too many login attempts. Please try again after 15 minutes.', {
    name: 'student-login', skipSuccessfulRequests: true
});
// AI assistant: protects the paid upstream API
const aiLimiter = make(60 * 1000, 15, 'Too many AI requests. Please wait a moment.', { name: 'ai' });
// Review submission: per logged-in student (falls back to IP)
const reviewLimiter = make(60 * 60 * 1000, 5, 'Too many reviews submitted. Please try again later.', { name: 'review', keyGenerator: userKey });
// Money-moving writes (collect, charge, adjust, refund) per logged-in user
const paymentWriteLimiter = make(60 * 1000, 40, 'Too many payment actions. Please wait a minute.', { name: 'payment-write', keyGenerator: userKey });
const refundLimiter = make(60 * 60 * 1000, 20, 'Too many refunds in the last hour. Please try again later.', { name: 'refund', keyGenerator: userKey });
// Bulk data pulls (CSV/Excel exports)
const exportLimiter = make(5 * 60 * 1000, 10, 'Too many export requests. Please wait a few minutes.', { name: 'export', keyGenerator: userKey });
// Staff messaging every student
const broadcastLimiter = make(60 * 60 * 1000, 10, 'Too many broadcasts in the last hour. Please try again later.', { name: 'broadcast', keyGenerator: userKey });

module.exports = {
    limiter, accountKey, userKey,
    loginLimiter, accountLoginLimiter, otpLimiter, accountOtpLimiter, otpVerifyLimiter, accountOtpVerifyLimiter,
    generalLimiter, apiLimiter, refreshLimiter,
    registerLimiter, enquiryLimiter, studentLoginLimiter, aiLimiter, reviewLimiter,
    paymentWriteLimiter, refundLimiter, exportLimiter, broadcastLimiter,
};
