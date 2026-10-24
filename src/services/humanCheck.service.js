const crypto = require('crypto');
const config = require('../config/config');
const HumanCheckState = require('../models/humanCheckState.model');

// Human verification: Cloudflare Turnstile / hCaptcha when configured, otherwise a stateless HMAC-signed
// proof-of-work challenge. See backend/doc/onboarding-contract.md section 2.

const POW_TTL_MS = 5 * 60 * 1000;
const POW_MIN_AGE_MS = 1500;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 5000;
const MIN_FILL_MS = 1500;

const PROVIDERS = {
    turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    hcaptcha: 'https://api.hcaptcha.com/siteverify',
};

const env = () => process.env;
const isProd = () => env().NODE_ENV === 'production';

/** 'turnstile' | 'hcaptcha' | 'pow' | 'off'. 'off' is honoured outside production only. */
const provider = () => {
    const p = String(env().HUMAN_CHECK_PROVIDER || '').trim().toLowerCase();
    if (p === 'turnstile' || p === 'hcaptcha') return p;
    if (p === 'off' && !isProd()) return 'off';
    return 'pow'; // 'none', unset, or 'off' in production
};

const powBits = () => {
    const n = parseInt(env().HUMAN_CHECK_POW_BITS, 10);
    return Number.isFinite(n) ? Math.min(24, Math.max(12, n)) : 18;
};

const loginThreshold = () => {
    const n = parseInt(env().HUMAN_CHECK_LOGIN_THRESHOLD, 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
};

const publicConfig = () => ({
    provider: provider(),
    siteKey: provider() === 'turnstile' || provider() === 'hcaptcha' ? (env().HUMAN_CHECK_SITE_KEY || null) : null,
    challengeUrl: '/v1/public/human-challenge',
    loginThreshold: loginThreshold(),
});

// ---------------------------------------------------------------- proof of work
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payloadB64) => crypto.createHmac('sha256', `${config.jwt.secret}:human-check`).update(payloadB64).digest('base64url');

const issueChallenge = (now = Date.now()) => {
    const payload = { id: crypto.randomBytes(12).toString('hex'), d: powBits(), iat: now, exp: now + POW_TTL_MS };
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
const checkPow = (token, now = Date.now()) => {
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

/**
 * Verify a human token. Returns { ok, reason?, unavailable? }.
 * Honeypot and fill-time are checked separately via softSignals (they apply to every provider).
 */
const verifyToken = async (token, { ip, fetchImpl, now } = {}) => {
    const p = provider();
    if (p === 'off') return { ok: true, skipped: true };
    if (!token || typeof token !== 'string' || token.length > 4000) return { ok: false, reason: 'missing' };
    if (p === 'turnstile' || p === 'hcaptcha') return verifyWithProvider(p, token, ip, fetchImpl);
    const r = checkPow(token, now);
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

/** true when the identifier or the IP has reached the failure threshold inside the window */
const loginNeedsChallenge = async (identifier, ip) => {
    const keys = failKeys(identifier, ip);
    if (!keys.length) return false;
    const rows = await HumanCheckState.find({ kind: 'fail', key: { $in: keys }, expiresAt: { $gt: new Date() } }).select('count').lean();
    return rows.some((r) => r.count >= loginThreshold());
};

module.exports = {
    provider, publicConfig, loginThreshold, powBits,
    issueChallenge, checkPow, leadingZeroBits, consumePowId,
    verifyWithProvider, verifyToken, softSignals,
    recordLoginFailure, clearLoginFailures, loginNeedsChallenge,
    POW_MIN_AGE_MS, MIN_FILL_MS,
};
