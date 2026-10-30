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
const { isMobileClient, appVersion } = require('../utils/clientPlatform');

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
const signAccess = ({ userId, userType, sid, impersonatedBy = null, ttlSeconds = config.jwt.accessTtlSeconds, client = null }) =>
    jwt.sign(
        { id: userId, type: userType, sid: String(sid), ...(impersonatedBy ? { impersonatedBy } : {}), ...(client ? { cl: client } : {}) },
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
 * Native apps (header "X-Client-Platform: mobile", see utils/clientPlatform.js) have no browser cookie jar and no Origin.
 * They do NOT use refresh tokens: sign-in issues one long-lived access token (MOBILE_ACCESS_TOKEN_TTL, default 30 days, hard cap
 * 90 days) that is still tied to a Session row, so logout, "log out everywhere", password change/reset, disabling the account and
 * library suspension end it within seconds, exactly like a web session. While the phone is in use the token is renewed in place
 * (header X-New-Access-Token, see maybeReissueMobile); an idle phone's token simply expires. Browsers keep the short access
 * token + HttpOnly rotating refresh cookie and are unchanged.
 */
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
    const mobile = isMobileClient(req);
    const persistent = mobile ? true : String(req.headers['x-session-persist'] || '1') !== '0';
    const userId = login.userData.id;
    const userType = login.userData.userType;
    const libraryId = login.userData.libraryId?._id || login.userData.libraryId || null;
    const now = Date.now();
    const d = describeRequest(req);

    if (mobile) {
        // one revocable row, no refresh secret; the idle expiry is the token lifetime, the absolute cap is 90 days
        const ttl = config.jwt.mobileAccessTtlSeconds;
        const absolute = new Date(now + config.jwt.mobileMaxSessionSeconds * 1000);
        const expiresAt = new Date(Math.min(now + ttl * 1000, absolute.getTime()));
        const version = appVersion(req);
        const session = await Session.create({
            userId, userType, libraryId: mongoose.Types.ObjectId.isValid(libraryId) ? libraryId : null,
            refreshHash: null, persistent: true,
            ip: d.ip, userAgent: d.userAgent, device: ('Mobile app' + (version ? ' v' + version : '') + (d.device?.summary ? ' (' + d.device.summary + ')' : '')).slice(0, 120),
            absoluteExpiresAt: absolute, expiresAt,
        });
        trimSessions(userId, userType).catch(() => {});
        const tokenTtl = Math.max(60, Math.floor((expiresAt.getTime() - now) / 1000));
        return {
            ...login,
            token: signAccess({ userId, userType, sid: session._id, ttlSeconds: tokenTtl, client: 'm' }),
            sessionId: String(session._id),
            expiresIn: tokenTtl,
        };
    }

    const absolute = new Date(now + ABSOLUTE_MS);
    const expiresAt = new Date(Math.min(now + (persistent ? IDLE_MS : SESSION_ONLY_IDLE_MS), absolute.getTime()));
    const secret = crypto.randomBytes(48).toString('base64url');
    const session = await Session.create({
        userId, userType, libraryId: mongoose.Types.ObjectId.isValid(libraryId) ? libraryId : null,
        refreshHash: sha256(secret), persistent,
        ip: d.ip, userAgent: d.userAgent, device: d.device?.summary || null,
        absoluteExpiresAt: absolute, expiresAt,
    });
    setRefreshCookie(req, res, session._id, secret, persistent, expiresAt);
    trimSessions(userId, userType).catch(() => {});
    return {
        ...login,
        token: signAccess({ userId, userType, sid: session._id }),
        sessionId: String(session._id),
    };
};

/**
 * Sliding renewal for native apps: when a mobile access token has less than half of its lifetime left and the request already
 * passed every check, send a fresh token for the SAME session in the X-New-Access-Token header and push the session's idle
 * expiry forward (never past its 90-day absolute cap). Idle phones are not renewed and so expire.
 */
const maybeReissueMobile = async (decoded, res) => {
    try {
        if (!decoded || decoded.cl !== 'm' || !decoded.exp || !decoded.iat || decoded.impersonatedBy) return;
        const nowS = Math.floor(Date.now() / 1000);
        const total = decoded.exp - decoded.iat;
        const left = decoded.exp - nowS;
        if (total <= 0 || left > total / 2) return;
        const row = await Session.findOne({ _id: decoded.sid, userId: decoded.id, revokedAt: null }).select('absoluteExpiresAt').lean();
        if (!row) return;
        const now = Date.now();
        const ttl = Math.min(config.jwt.mobileAccessTtlSeconds, Math.floor((new Date(row.absoluteExpiresAt).getTime() - now) / 1000));
        if (ttl <= left) return; // already at the hard cap: nothing to extend
        const expiresAt = new Date(now + ttl * 1000);
        await Session.updateOne({ _id: decoded.sid, revokedAt: null }, { $set: { expiresAt, lastUsedAt: new Date(now) } });
        forgetActive(decoded.sid);
        res.set('X-New-Access-Token', signAccess({ userId: decoded.id, userType: decoded.type, sid: decoded.sid, ttlSeconds: ttl, client: 'm' }));
        res.set('X-New-Access-Token-Expires-In', String(ttl));
    } catch (e) { /* renewal is a convenience: never fail the request because of it */ }
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
    if (isMobileClient(req)) {
        // native apps hold one long-lived revocable access token and have no refresh token to present
        throw fail(401, 'Session expired. Please log in again.', { errorCode: 'MOBILE_NO_REFRESH' });
    }
    assertSameOriginRequest(req);
    const raw = readRefreshCookie(req);
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
        else setRefreshCookie(req, res, session._id, newSecret, session.persistent, expiresAt);
    }

    return {
        token: signAccess({ userId: session.userId, userType: session.userType, sid: session._id }),
        userType: session.userType,
        expiresIn: config.jwt.accessTtlSeconds,
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

/**
 * POST /public/logout. Browsers: revoke the session named in the refresh cookie (works with an expired access token too).
 * Native apps: revoke the session named in their bearer token. The signature is verified (an expired token is fine), so only
 * the holder of a genuine token for that session can end it.
 */
const logout = async (req, res) => {
    if (isMobileClient(req)) {
        const token = String(req.headers.authorization || '').split(' ')[1] || '';
        let decoded = null;
        try { decoded = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], ignoreExpiration: true }); } catch (_) { decoded = null; }
        if (!decoded || !decoded.sid || !decoded.id || decoded.purpose || !mongoose.Types.ObjectId.isValid(decoded.sid)) return;
        const s = await Session.findOne({ _id: decoded.sid, userId: decoded.id }).select('userId userType libraryId revokedAt').lean();
        if (s && !s.revokedAt) {
            await revokeSession(decoded.sid, 'logout');
            securityLog.record(req, { type: 'logout', outcome: 'success', userId: s.userId, userType: s.userType, libraryId: s.libraryId, meta: { client: 'mobile' } });
        }
        return;
    }
    assertSameOriginRequest(req);
    const [sid] = String(readRefreshCookie(req) || '').split('.');
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
    refresh, logout, maybeReissueMobile, revokeSession, revokeAllForUser, revokeAllForLibrary, listForUser,
    // exported for tests
    _sha256: sha256, _readRefreshCookie: readRefreshCookie,
};
