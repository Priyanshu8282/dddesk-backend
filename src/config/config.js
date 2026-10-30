const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const envVars = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT || 5005,
    MONGODB_URL: process.env.MONGODB_URL || process.env.MONGODB_URI,
    JWT_SECRET: process.env.JWT_SECRET,
    // Access tokens are short-lived; the refresh cookie (see services/session.service.js) keeps the user signed in.
    // JWT_EXPIRATION is the legacy name of this setting; anything longer than 1 hour is ignored on purpose.
    ACCESS_TOKEN_TTL: process.env.ACCESS_TOKEN_TTL || '30m',
};

if (!envVars.JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET environment variable is not set. Server cannot start.');
}

const { NODE_ENV, PORT, MONGODB_URL } = envVars;

// "30m" / "15m" / "3600" -> seconds (JWT library format subset)
const ttlSeconds = (v, fallback) => {
    const m = /^(\d+)\s*([smhd]?)$/i.exec(String(v || '').trim());
    if (!m) return fallback;
    const n = Number(m[1]);
    const unit = (m[2] || 's').toLowerCase();
    return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit]);
};
const MAX_ACCESS_TTL_S = 3600;
const accessTtlSeconds = Math.min(ttlSeconds(envVars.ACCESS_TOKEN_TTL, 1800), MAX_ACCESS_TTL_S);
// Native apps (header "X-Client-Platform: mobile") get a longer-lived access token that is still bound to a revocable session
// row. Default 30 days, never more than 90 days (the session row also has a 90-day hard cap).
const MAX_MOBILE_TTL_S = 90 * 86400;
const mobileAccessTtlSeconds = Math.min(Math.max(ttlSeconds(envVars.MOBILE_ACCESS_TOKEN_TTL, 30 * 86400), 3600), MAX_MOBILE_TTL_S);

// MongoDB configuration
const mongooseConfig = {
    url: MONGODB_URL + (NODE_ENV === 'test' ? '-test' : ''),
};

/**
 * Production start-up checks. Returns a list of problems (empty = fine); the caller decides to throw.
 * Pure function of the env it is given, so it can be unit-tested.
 */
const productionProblems = (env = process.env) => {
    const problems = [];
    const secret = String(env.JWT_SECRET || '');
    if (secret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
    if (/^(secret|changeme|change-me|password|jwt_secret|your[-_ ]?secret|dev|test|default)/i.test(secret) || /change[-_ ]?me|your[-_ ]?secret|example|dummy/i.test(secret)) {
        problems.push('JWT_SECRET looks like a placeholder/default value');
    }
    if (String(env.OTP_IN_RESPONSE || '').toLowerCase() === 'true') problems.push('OTP_IN_RESPONSE must not be true in production');
    if (!String(env.CRON_SECRET || '').trim()) problems.push('CRON_SECRET is not set');
    const origins = [env.ALLOWED_ORIGINS, env.FRONTEND_URL].join(',').split(',').map((s) => s.trim()).filter(Boolean);
    if (!origins.length) problems.push('ALLOWED_ORIGINS (or FRONTEND_URL) is empty: no browser origin would be allowed');
    if (origins.some((o) => o === '*' || o.includes('*'))) problems.push('ALLOWED_ORIGINS must not contain wildcards');
    if (origins.some((o) => /^http:\/\/(?!localhost|127\.0\.0\.1)/i.test(o))) problems.push('ALLOWED_ORIGINS must use https in production');
    if (!String(env.MONGODB_URL || env.MONGODB_URI || '').trim()) problems.push('MONGODB_URL is not set');
    // Human verification (signup wizard, forgot-password, login after failures)
    const hp = String(env.HUMAN_CHECK_PROVIDER || '').trim().toLowerCase();
    if ((hp === 'recaptcha' || hp === 'turnstile' || hp === 'hcaptcha') && !String(env.HUMAN_CHECK_SECRET_KEY || '').trim()) problems.push('HUMAN_CHECK_SECRET_KEY is not set while HUMAN_CHECK_PROVIDER=' + hp);
    if ((hp === 'recaptcha' || hp === 'turnstile' || hp === 'hcaptcha') && !String(env.HUMAN_CHECK_SITE_KEY || '').trim()) problems.push('HUMAN_CHECK_SITE_KEY is not set while HUMAN_CHECK_PROVIDER=' + hp);
    if (hp === 'off') problems.push('HUMAN_CHECK_PROVIDER=off is not allowed in production');
    if (!String(env.RAZORPAY_WEBHOOK_SECRET || '').trim() && String(env.RAZORPAY_KEY_ID || '').trim()) {
        problems.push('RAZORPAY_WEBHOOK_SECRET is not set while Razorpay keys are configured');
    }
    if (env.DISABLE_SECURITY_STARTUP_CHECKS === 'true') return [];
    return problems;
};

// Soft warnings (do not stop the server)
const productionWarnings = (env = process.env) => {
    const w = [];
    const hp = String(env.HUMAN_CHECK_PROVIDER || '').trim().toLowerCase();
    if (hp !== 'recaptcha' && hp !== 'turnstile' && hp !== 'hcaptcha') w.push('HUMAN_CHECK_PROVIDER is not recaptcha/turnstile/hcaptcha: the built-in proof-of-work check is used. Set HUMAN_CHECK_PROVIDER=recaptcha (Google reCAPTCHA v2 checkbox) for stronger bot protection.');
    return w;
};

if (NODE_ENV === 'production') {
    productionWarnings().forEach((m) => console.warn('[security] ' + m));
    const problems = productionProblems();
    if (problems.length) {
        throw new Error('FATAL: insecure production configuration:\n - ' + problems.join('\n - '));
    }
}

const config = {
    env: NODE_ENV,
    port: PORT,
    mongoose: mongooseConfig,
    jwt: {
        secret: envVars.JWT_SECRET,
        // seconds (number): jsonwebtoken treats a bare number as seconds
        expiration: accessTtlSeconds,
        accessTtlSeconds,
        mobileAccessTtlSeconds,
        mobileMaxSessionSeconds: MAX_MOBILE_TTL_S,
    },
    productionProblems,
    productionWarnings,
};

module.exports = config;
