const crypto = require('crypto');
const config = require('../config/config');
const HumanCheckState = require('../models/humanCheckState.model');

// Human verification: Google reCAPTCHA v2 checkbox / Cloudflare Turnstile / hCaptcha when configured, otherwise a stateless HMAC-signed
// proof-of-work challenge. See backend/doc/onboarding-contract.md section 2.

const POW_TTL_MS = 5 * 60 * 1000;
const POW_MIN_AGE_MS = 1500;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 5000;
const MIN_FILL_MS = 1500;

const PROVIDERS = {
    turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    hcaptcha: 'https://api.hcaptcha.com/siteverify',
    recaptcha: 'https://www.google.com/recaptcha/api/siteverify', // reCAPTCHA v2 "I'm not a robot" checkbox
};

const env = () => process.env;
const isProd = () => env().NODE_ENV === 'production';

/** 'recaptcha' | 'turnstile' | 'hcaptcha' | 'pow' | 'off'. 'off' is honoured outside production only. */
const provider = () => {
    const p = String(env().HUMAN_CHECK_PROVIDER || '').trim().toLowerCase();
    if (p === 'recaptcha' || p === 'turnstile' || p === 'hcaptcha') return p;
    if (p === 'off' && !isProd()) return 'off';
    return 'pow'; // 'none', unset, or 'off' in production
};

const powBits = () => {
    const n = parseInt(env().HUMAN_CHECK_POW_BITS, 10);
    return Number.isFinite(n) ? Math.min(24, Math.max(12, n)) : 18;
};

// Native apps cannot show a captcha widget, so they solve the proof-of-work puzzle. Default: one bit harder than the web fallback,
// but never above 17 bits: the solver runs in JavaScript on the phone (Hermes has no JIT), where 17 bits is a second or two and every
// extra bit doubles that. A puzzle this size only adds friction for naive scripts (an attacker's native code does it in microseconds):
// the real protection is the per-IP and per-account rate limits and the account lockout. Raise it with HUMAN_CHECK_MOBILE_POW_BITS.
const MOBILE_DEFAULT_MAX_BITS = 17;
const mobilePowBits = () => {
    const n = parseInt(env().HUMAN_CHECK_MOBILE_POW_BITS, 10);
    return Number.isFinite(n) ? Math.min(24, Math.max(12, n)) : Math.min(MOBILE_DEFAULT_MAX_BITS, powBits() + 1);
};

const mobileAbuseThreshold = () => {
    const n = parseInt(env().HUMAN_CHECK_MOBILE_ABUSE_THRESHOLD, 10);
    return Number.isFinite(n) && n > 0 ? n : 10;
};

const loginThreshold = () => {
    const n = parseInt(env().HUMAN_CHECK_LOGIN_THRESHOLD, 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
};

const publicConfig = () => ({
    // the API contract names the "checks skipped" mode 'none' (the server-side value is 'off')
    provider: provider() === 'off' ? 'none' : provider(),
    siteKey: ['recaptcha', 'turnstile', 'hcaptcha'].includes(provider()) ? (env().HUMAN_CHECK_SITE_KEY || null) : null,
    challengeUrl: '/v1/public/human-challenge',
    loginThreshold: loginThreshold(),
});

// ---------------------------------------------------------------- proof of work
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payloadB64) => crypto.createHmac('sha256', `${config.jwt.secret}:human-check`).update(payloadB64).digest('base64url');

const issueChallenge = (now = Date.now(), { mobile = false } = {}) => {
    const payload = { id: crypto.randomBytes(12).toString('hex'), d: mobile ? mobilePowBits() : powBits(), iat: now, exp: now + POW_TTL_MS };
    const p = b64(JSON.stringify(payload));
    return { challenge: `${p}.${sign(p)}`, difficulty: payload.d, expiresAt: payload.exp, algorithm: 'sha256-leading-zero-bits' };
};

const leadingZeroBits = (buf) => {
    let bits = 0;
    for (const byte of buf) {
        if (byte === 0) { bits += 8; continue; }
        bits += Math.clz32(byte) - 24;
        break;
    }
    return bits;
};

/** Pure check of a signed challenge + nonce (no replay storage). Returns { ok, id, expiresAt, reason }. */
const checkPow = (token, now = Date.now(), { minBits = 0 } = {}) => {
    const raw = String(token || '');
    const tilde = raw.lastIndexOf('~');
    if (tilde < 1) return { ok: false, reason: 'malformed' };
    const challenge = raw.slice(0, tilde);
    const nonce = raw.slice(tilde + 1);
    if (!/^\d{1,12}$/.test(nonce)) return { ok: false, reason: 'malformed' };
    const dot = challenge.indexOf('.');
    if (dot < 1) return { ok: false, reason: 'malformed' };
    const p = challenge.slice(0, dot);
    const sig = challenge.slice(dot + 1);
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(p));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
    let payload;
    try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (_) { return { ok: false, reason: 'malformed' }; }
    if (!payload || typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || typeof payload.d !== 'number' || !payload.id) return { ok: false, reason: 'malformed' };
    if (now > payload.exp) return { ok: false, reason: 'expired' };
    if (now - payload.iat < POW_MIN_AGE_MS) return { ok: false, reason: 'too_fast' };
    // a mobile client must have solved a challenge at (at least) the mobile difficulty, not the cheaper web one
    if (minBits && payload.d < minBits) return { ok: false, reason: 'difficulty_too_low' };
    const hash = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
    if (leadingZeroBits(hash) < payload.d) return { ok: false, reason: 'insufficient_work' };
    return { ok: true, id: payload.id, expiresAt: payload.exp };
};

/** Atomically marks the challenge id used; false if it was already used (replay). */
const consumePowId = async (id, expiresAt) => {
    try {
        await HumanCheckState.create({ kind: 'pow', key: id, count: 1, expiresAt: new Date(expiresAt + 60 * 1000) });
        return true;
    } catch (e) {
        if (e && e.code === 11000) return false;
        throw e;
    }
};

// ---------------------------------------------------------------- provider verification
const verifyWithProvider = async (name, token, ip, fetchImpl = globalThis.fetch) => {
    const secret = env().HUMAN_CHECK_SECRET_KEY;
    if (!secret) return { ok: false, unavailable: true, reason: 'secret_missing' };
    const body = new URLSearchParams({ secret, response: String(token) });
    if (ip && ip !== 'unknown') body.set('remoteip', ip);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS);
    try {
        const res = await fetchImpl(PROVIDERS[name], {
            method: 'POST', body, signal: ctrl.signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!res.ok) return { ok: false, unavailable: true, reason: `http_${res.status}` };
        const json = await res.json();
        if (json && json.success === true) return { ok: true };
        return { ok: false, reason: Array.isArray(json && json['error-codes']) ? json['error-codes'].join(',').slice(0, 120) : 'rejected' };
    } catch (e) {
        return { ok: false, unavailable: true, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
        clearTimeout(timer);
    }
};

// A widget token may be used once. The providers reject replays themselves, but a short in-memory cache stops a replay
// even when the provider is slow or unreachable. Tokens expire at the provider after about 2 minutes, so the cache stays small.
const USED_TTL_MS = 3 * 60 * 1000;
const usedTokens = new Map();
const tokenKey = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const markUsed = (t, now = Date.now()) => {
    if (usedTokens.size > 5000) for (const [k, exp] of usedTokens) if (exp < now) usedTokens.delete(k);
    const k = tokenKey(t);
    if (usedTokens.has(k) && usedTokens.get(k) > now) return false;
    usedTokens.set(k, now + USED_TTL_MS);
    return true;
};

/**
 * Verify a human token. Returns { ok, reason?, unavailable? }.
 * Honeypot and fill-time are checked separately via softSignals (they apply to every provider).
 */
const verifyToken = async (token, { ip, fetchImpl, now, silent = false, mobile = false } = {}) => {
    const p = provider();
    if (p === 'off') return { ok: true, skipped: true };
    if (!token || typeof token !== 'string' || token.length > 4000) return { ok: false, reason: 'missing' };
    // `silent` = forms without a visible checkbox (forgot password, contact): they send the automatic proof-of-work token
    // even when a widget provider is configured, because a checkbox widget cannot run invisibly
    // a native app (mobile) always uses the puzzle: it cannot run a captcha widget
    const widgetProvider = !silent && !mobile;
    if (p === 'recaptcha' && widgetProvider) {
        if (!markUsed(token, now)) return { ok: false, reason: 'replayed' };
        const r = await verifyWithProvider(p, token, ip, fetchImpl);
        if (!r.ok) usedTokens.delete(tokenKey(token)); // a rejected or unreachable check does not burn the token
        return r;
    }
    if ((p === 'turnstile' || p === 'hcaptcha') && widgetProvider) return verifyWithProvider(p, token, ip, fetchImpl);
    const r = checkPow(token, now, mobile ? { minBits: mobilePowBits() } : {});
    if (!r.ok) return r;
    const fresh = await consumePowId(r.id, r.expiresAt);
    return fresh ? { ok: true } : { ok: false, reason: 'replayed' };
};

/** Honeypot + fill-time. Returns null when fine, else a reason string. */
const softSignals = (body = {}) => {
    if (body.hp_website !== undefined && body.hp_website !== null && String(body.hp_website).trim() !== '') return 'honeypot';
    if (body.fillMs !== undefined && body.fillMs !== null && body.fillMs !== '') {
        const n = Number(body.fillMs);
        if (!Number.isFinite(n) || n < MIN_FILL_MS) return 'too_fast';
    }
    return null;
};

// ---------------------------------------------------------------- failed-login counters (login challenge after N failures)
const failKeys = (identifier, ip) => {
    const keys = [];
    const id = String(identifier || '').trim().toLowerCase().slice(0, 120);
    if (id) keys.push('a:' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 32));
    if (ip && ip !== 'unknown') keys.push('ip:' + String(ip).slice(0, 64));
    return keys;
};

const recordLoginFailure = async (identifier, ip) => {
    const expiresAt = new Date(Date.now() + FAIL_WINDOW_MS);
    await Promise.all(failKeys(identifier, ip).map((key) =>
        HumanCheckState.updateOne({ kind: 'fail', key }, { $inc: { count: 1 }, $set: { expiresAt } }, { upsert: true }).catch(() => {})));
};

const clearLoginFailures = async (identifier) => {
    const [acct] = failKeys(identifier, null);
    if (acct) await HumanCheckState.deleteOne({ kind: 'fail', key: acct }).catch(() => {});
};

/**
 * Count a failed human check from a native app. Returns true exactly once per window: when this address reaches
 * HUMAN_CHECK_MOBILE_ABUSE_THRESHOLD failures (the caller raises one security event, so a bot hammering the weaker mobile path is noticed).
 */
const recordMobileFailure = async (ip) => {
    if (!ip || ip === 'unknown') return false;
    const expiresAt = new Date(Date.now() + FAIL_WINDOW_MS);
    const row = await HumanCheckState.findOneAndUpdate(
        { kind: 'mfail', key: 'ip:' + String(ip).slice(0, 64) },
        { $inc: { count: 1 }, $set: { expiresAt } },
        { upsert: true, new: true }
    ).lean().catch(() => null);
    return !!row && row.count === mobileAbuseThreshold();
};

/** true when the identifier or the IP has reached the failure threshold inside the window */
const loginNeedsChallenge = async (identifier, ip) => {
    const keys = failKeys(identifier, ip);
    if (!keys.length) return false;
    const rows = await HumanCheckState.find({ kind: 'fail', key: { $in: keys }, expiresAt: { $gt: new Date() } }).select('count').lean();
    return rows.some((r) => r.count >= loginThreshold());
};

module.exports = {
    provider, publicConfig, loginThreshold, powBits, mobilePowBits, recordMobileFailure,
    issueChallenge, checkPow, leadingZeroBits, consumePowId,
    verifyWithProvider, verifyToken, softSignals, PROVIDERS, _resetUsedTokens: () => usedTokens.clear(),
    recordLoginFailure, clearLoginFailures, loginNeedsChallenge,
    POW_MIN_AGE_MS, MIN_FILL_MS,
};
