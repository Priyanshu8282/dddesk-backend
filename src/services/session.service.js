const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Session = require('../models/session.model');
const Admin = require('../models/admin.model');
const Student = require('../models/student.model');
const config = require('../config/config');
const { isAllowedOrigin, normalize } = require('../config/cors');
const { describeRequest } = require('../utils/device');
const securityLog = require('../utils/securityLog');

const COOKIE_NAME = 'dd_rt';
const COOKIE_PATH = '/v1/public';           // the cookie is only ever sent to the refresh/logout endpoints
const DAY = 86400 * 1000;
const IDLE_MS = Number(process.env.REFRESH_IDLE_DAYS || 7) * DAY;
const ABSOLUTE_MS = Number(process.env.REFRESH_ABSOLUTE_DAYS || 30) * DAY;
const SESSION_ONLY_IDLE_MS = 1 * DAY;       // "don't remember me": the cookie dies with the browser, the row after a day idle
const ROTATION_GRACE_MS = 20 * 1000;        // a parallel tab may still present the previous token for a few seconds
const MAX_SESSIONS_PER_USER = Number(process.env.MAX_SESSIONS_PER_USER || 10);
const ACTIVE_CACHE_TTL_MS = Number(process.env.SESSION_CACHE_TTL_MS ?? 5000);

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const safeEq = (a, b) => {
    const x = Buffer.from(String(a || ''), 'hex');
    const y = Buffer.from(String(b || ''), 'hex');
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, statusCode: status, ...extra });

// ---------------------------------------------------------------------------
// "Is this session still alive?" - checked on every API call, cached for a few seconds per process.
// Revoking in this process clears the cache entry at once; other instances catch up within the TTL.
// ---------------------------------------------------------------------------
const activeCache = new Map(); // sid -> { at, ok }
const ACTIVE_CACHE_MAX = 5000;

const isActive = async (sid, userId) => {
    if (!sid || !mongoose.Types.ObjectId.isValid(sid)) return false;
    const key = String(sid) + ':' + String(userId);
    const hit = activeCache.get(key);
    if (hit && Date.now() - hit.at < ACTIVE_CACHE_TTL_MS) return hit.ok;
    const row = await Session.findOne({ _id: sid, userId, revokedAt: null, expiresAt: { $gt: new Date() } }).select('_id').lean();
    const ok = !!row;
    if (ACTIVE_CACHE_TTL_MS) {
        if (activeCache.size >= ACTIVE_CACHE_MAX) activeCache.delete(activeCache.keys().next().value);
        activeCache.set(key, { at: Date.now(), ok });
    }
    return ok;
};
const forgetActive = (sid) => {
    for (const k of activeCache.keys()) if (k.startsWith(String(sid) + ':')) activeCache.delete(k);
};
const forgetActiveForUser = (userId) => {
    for (const k of activeCache.keys()) if (k.endsWith(':' + String(userId))) activeCache.delete(k);
};

// ---------------------------------------------------------------------------
// Tokens + cookie
// ---------------------------------------------------------------------------
const signAccess = ({ userId, userType, sid, impersonatedBy = null, ttlSeconds = config.jwt.accessTtlSeconds }) =>
    jwt.sign(
        { id: userId, type: userType, sid: String(sid), ...(impersonatedBy ? { impersonatedBy } : {}) },
        config.jwt.secret,
        { algorithm: 'HS256', expiresIn: ttlSeconds }
    );

const cookieBase = (req) => {
    const production = process.env.NODE_ENV === 'production';
    const sameSite = (process.env.REFRESH_COOKIE_SAMESITE || (production ? 'none' : 'lax')).toLowerCase();
    return {
        httpOnly: true,
        // SameSite=None is only accepted by browsers together with Secure
        secure: production || sameSite === 'none' || !!(req && req.secure),
        sameSite,
        path: COOKIE_PATH,
        ...(process.env.REFRESH_COOKIE_DOMAIN ? { domain: process.env.REFRESH_COOKIE_DOMAIN } : {}),
    };
};

const setRefreshCookie = (req, res, sid, secret, persistent, expiresAt) => {
    const opts = cookieBase(req);
    if (persistent) opts.expires = expiresAt; // omitted = browser-session cookie
    res.cookie(COOKIE_NAME, `${sid}.${secret}`, opts);
};
const clearRefreshCookie = (req, res) => {
    const { httpOnly, secure, sameSite, path, domain } = cookieBase(req);
    res.clearCookie(COOKIE_NAME, { httpOnly, secure, sameSite, path, ...(domain ? { domain } : {}) });
};

/**
 * Native apps have no browser cookie jar and no Origin. A client that sends "X-Client-Type: mobile" gets the refresh token
 * in the JSON body and presents it in the body (keep it in the Keychain/Keystore). That mode has no ambient credential,
 * so the cookie-only CSRF origin check is not needed there; rotation, reuse detection and revocation are identical.
 * Browsers keep using the HttpOnly cookie, which is never readable by scripts.
 */
const isMobileClient = (req) => String(req.headers['x-client-type'] || '').trim().toLowerCase() === 'mobile';

const readBodyRefreshToken = (req) => {
    const v = req.body && typeof req.body.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
    return v.length > 0 && v.length <= 400 ? v : null;
};

const readRefreshCookie = (req) => {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() !== COOKIE_NAME) continue;
        try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { return null; }
    }
    return null;
};

/**
 * Cookie-authenticated endpoints (refresh, logout) must not be callable from another site:
 * a custom header (forces a CORS preflight) and a known Origin are both required.
 */
const assertSameOriginRequest = (req) => {
    const origin = req.headers.origin || (() => { try { return new URL(req.headers.referer).origin; } catch (_) { return ''; } })();
    const header = String(req.headers['x-requested-with'] || '');
    if (!header || !origin || !isAllowedOrigin(normalize(origin) || origin)) {
        securityLog.record(req, { type: 'forbidden', outcome: 'blocked', reason: 'csrf_origin', meta: { origin: String(origin).slice(0, 200) } });
        throw fail(403, 'Request not allowed from this origin');
    }
};

// ---------------------------------------------------------------------------
// Create / rotate / revoke
// ---------------------------------------------------------------------------
const trimSessions = async (userId, userType) => {
    // keep the newest MAX_SESSIONS_PER_USER live sessions; older ones are revoked (stops unbounded growth)
    const live = await Session.find({ userId, userType, revokedAt: null, impersonatedBy: null, expiresAt: { $gt: new Date() } })
        .sort({ lastUsedAt: -1 }).select('_id').lean();
    const extra = live.slice(MAX_SESSIONS_PER_USER).map((s) => s._id);
    if (extra.length) {
        await Session.updateMany({ _id: { $in: extra } }, { $set: { revokedAt: new Date(), revokedReason: 'session_limit' } });
        extra.forEach(forgetActive);
    }
};

/**
 * Called after a successful login/OTP check. Creates the session row, sets the refresh cookie and returns the access token.
 * `login` is the {token, userData, role} object produced by auth.service (its own token is replaced).
 */
const startLoginSession = async (req, res, login) => {
    const persistent = String(req.headers['x-session-persist'] || '1') !== '0';
    const userId = login.userData.id;
    const userType = login.userData.userType;
    const libraryId = login.userData.libraryId?._id || login.userData.libraryId || null;
    const now = Date.now();
    const absolute = new Date(now + ABSOLUTE_MS);
    const expiresAt = new Date(Math.min(now + (persistent ? IDLE_MS : SESSION_ONLY_IDLE_MS), absolute.getTime()));
    const secret = crypto.randomBytes(48).toString('base64url');
    const d = describeRequest(req);
    const session = await Session.create({
        userId, userType, libraryId: mongoose.Types.ObjectId.isValid(libraryId) ? libraryId : null,
        refreshHash: sha256(secret), persistent,
        ip: d.ip, userAgent: d.userAgent, device: d.device?.summary || null,
        absoluteExpiresAt: absolute, expiresAt,
    });
    const mobile = isMobileClient(req);
    if (!mobile) setRefreshCookie(req, res, session._id, secret, persistent, expiresAt);
    trimSessions(userId, userType).catch(() => {});
    return {
        ...login,
        token: signAccess({ userId, userType, sid: session._id }),
        sessionId: String(session._id),
        ...(mobile ? { refreshToken: `${session._id}.${secret}`, refreshExpiresAt: expiresAt.toISOString() } : {}),
    };
};

/** Support (impersonation) session: short, no refresh token, revocable. */
const createImpersonationSession = async ({ owner, superAdminId, ttlSeconds = 30 * 60, ip = null, userAgent = null }) => {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const session = await Session.create({
        userId: owner._id, userType: 'admin', libraryId: owner.libraryId || null,
        refreshHash: null, impersonatedBy: superAdminId, persistent: false,
        ip, userAgent, device: 'Support session', absoluteExpiresAt: expiresAt, expiresAt,
    });
    return {
        sessionId: String(session._id), expiresAt,
        token: signAccess({ userId: owner._id, userType: 'admin', sid: session._id, impersonatedBy: superAdminId, ttlSeconds }),
    };
};

const loadAccountForRefresh = async (session) => {
    if (session.userType === 'student') {
        return Student.findById(session.userId).select('status isDeleted tokensValidAfter libraryId').lean();
    }
    return Admin.findById(session.userId).select('status isDeleted tokensValidAfter libraryId userType').lean();
};

const accountAllowed = (session, acct) => {
    if (!acct || acct.isDeleted) return false;
    if (session.userType === 'student') return acct.status === 'active';
    return acct.status === true;
};

/** POST /public/refresh: trade the refresh cookie for a new access token (and a rotated cookie). */
const refresh = async (req, res) => {
    const mobile = isMobileClient(req);
    if (!mobile) assertSameOriginRequest(req);
    const raw = mobile ? readBodyRefreshToken(req) : readRefreshCookie(req);
    const [sid, secret] = String(raw || '').split('.');
    const reject = (reason, status = 401) => {
        clearRefreshCookie(req, res);
        securityLog.record(req, { type: 'session_refresh', outcome: 'failure', reason, identifier: null });
        throw fail(status, 'Session expired. Please log in again.');
    };
    if (!sid || !secret || !mongoose.Types.ObjectId.isValid(sid)) return reject('no_cookie');

    const session = await Session.findById(sid);
    const now = new Date();
    if (!session || session.revokedAt || session.expiresAt <= now || session.absoluteExpiresAt <= now || !session.refreshHash) {
        return reject('session_inactive');
    }

    const presented = sha256(secret);
    let parallel = false;
    if (!safeEq(presented, session.refreshHash)) {
        if (session.prevRefreshHash && safeEq(presented, session.prevRefreshHash)) {
            if (session.rotatedAt && now - session.rotatedAt < ROTATION_GRACE_MS) parallel = true;
            else {
                // an old refresh token was replayed after it had been rotated: treat as theft and end the whole session
                await revokeSession(session._id, 'refresh_reuse');
                securityLog.record(req, { type: 'session_revoked', outcome: 'blocked', reason: 'refresh_reuse', userId: session.userId, userType: session.userType, libraryId: session.libraryId });
                return reject('refresh_reuse');
            }
        } else {
            return reject('bad_token');
        }
    }

    const acct = await loadAccountForRefresh(session);
    if (!accountAllowed(session, acct)) {
        await revokeSession(session._id, 'account_inactive');
        return reject('account_inactive');
    }
    if (acct.tokensValidAfter && session.createdAt < acct.tokensValidAfter) {
        await revokeSession(session._id, 'credentials_changed');
        return reject('credentials_changed');
    }

    let newSecret = null;
    let rotated = null; // mobile clients: the rotated token goes back in the body
    if (!parallel) {
        newSecret = crypto.randomBytes(48).toString('base64url');
        const idle = session.persistent ? IDLE_MS : SESSION_ONLY_IDLE_MS;
        const expiresAt = new Date(Math.min(now.getTime() + idle, session.absoluteExpiresAt.getTime()));
        const upd = await Session.findOneAndUpdate(
            { _id: session._id, refreshHash: session.refreshHash, revokedAt: null },
            { $set: { prevRefreshHash: session.refreshHash, refreshHash: sha256(newSecret), rotatedAt: now, lastUsedAt: now, expiresAt } },
            { new: true }
        );
        if (!upd) parallel = true; // lost a race against another tab: it holds the new cookie
        else if (mobile) rotated = { refreshToken: `${session._id}.${newSecret}`, refreshExpiresAt: expiresAt.toISOString() };
        else setRefreshCookie(req, res, session._id, newSecret, session.persistent, expiresAt);
    }

    return {
        token: signAccess({ userId: session.userId, userType: session.userType, sid: session._id }),
        userType: session.userType,
        expiresIn: config.jwt.accessTtlSeconds,
        ...(rotated || {}),
    };
};

const revokeSession = async (sid, reason = 'logout') => {
    await Session.updateOne({ _id: sid, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason, refreshHash: null, prevRefreshHash: null } });
    forgetActive(sid);
};

/** End every session of one account (password change/reset, disable, delete, "log out everywhere"). */
const revokeAllForUser = async (userId, reason = 'revoked', { exceptSid = null } = {}) => {
    if (!userId) return;
    const filter = { revokedAt: null, $or: [{ userId }, { impersonatedBy: userId }] };
    if (exceptSid) filter._id = { $ne: exceptSid };
    await Session.updateMany(filter, { $set: { revokedAt: new Date(), revokedReason: reason, refreshHash: null, prevRefreshHash: null } });
    forgetActiveForUser(userId);
    try { require('../middlewares/auth.middleware').invalidateAuthCache(userId); } catch (_) { /* not loaded */ }
};

/** End every session of every account of a library (suspension / deletion). */
const revokeAllForLibrary = async (libraryId, reason = 'library_suspended') => {
    if (!libraryId) return;
    await Session.updateMany({ libraryId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason, refreshHash: null, prevRefreshHash: null } });
    activeCache.clear();
};

/** POST /public/logout: revoke the session named in the refresh cookie (works even when the access token has expired). */
const logout = async (req, res) => {
    const mobile = isMobileClient(req);
    if (!mobile) assertSameOriginRequest(req);
    const [sid, secret] = String((mobile ? readBodyRefreshToken(req) : readRefreshCookie(req)) || '').split('.');
    // a body token must prove it is really this session's (an id alone must not be enough to sign someone out)
    if (mobile) {
        const row = sid && mongoose.Types.ObjectId.isValid(sid) && secret ? await Session.findById(sid).select('refreshHash prevRefreshHash').lean() : null;
        const matches = row && (safeEq(sha256(secret), row.refreshHash) || safeEq(sha256(secret), row.prevRefreshHash));
        if (!matches) return;
    }
    clearRefreshCookie(req, res);
    if (sid && mongoose.Types.ObjectId.isValid(sid)) {
        const s = await Session.findById(sid).select('userId userType libraryId revokedAt').lean();
        if (s && !s.revokedAt) {
            await revokeSession(sid, 'logout');
            securityLog.record(req, { type: 'logout', outcome: 'success', userId: s.userId, userType: s.userType, libraryId: s.libraryId });
        }
    }
};

const listForUser = (userId, userType) =>
    Session.find({ userId, userType, revokedAt: null, impersonatedBy: null, expiresAt: { $gt: new Date() } })
        .sort({ lastUsedAt: -1 }).select('ip device userAgent createdAt lastUsedAt persistent').lean();

module.exports = {
    COOKIE_NAME, isActive, forgetActive, signAccess, startLoginSession, createImpersonationSession,
    refresh, logout, revokeSession, revokeAllForUser, revokeAllForLibrary, listForUser,
    // exported for tests
    _sha256: sha256, _readRefreshCookie: readRefreshCookie,
};
