const securityLog = require('../utils/securityLog');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// NoSQL operator injection / prototype pollution guard.
// Mongo treats keys such as {"$gt": ""} or {"a.b": 1} as operators/paths. JSON bodies and query strings are user
// controlled, so any such key is removed before a controller or query builder can see it. Nothing is rejected:
// a legitimate client never sends these keys, so stripping them is enough, and every strip is logged.
// ---------------------------------------------------------------------------
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 12;
const MAX_ARRAY = 1000;

const isBadKey = (k) => k.startsWith('$') || k.includes('.') || FORBIDDEN_KEYS.has(k);

/** Returns a cleaned deep copy of plain data. `stats.removed` counts the dropped keys. */
const clean = (value, stats, depth = 0) => {
    if (depth > MAX_DEPTH) { stats.removed++; return undefined; }
    if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY) { stats.removed++; value = value.slice(0, MAX_ARRAY); }
        return value.map((v) => clean(v, stats, depth + 1));
    }
    if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
        const out = {};
        for (const k of Object.keys(value)) {
            if (isBadKey(k)) { stats.removed++; continue; }
            out[k] = clean(value[k], stats, depth + 1);
        }
        return out;
    }
    return value;
};

const sanitizeInput = (req, res, next) => {
    // the payment webhook is verified against its raw bytes and carries provider-defined keys: leave it untouched
    if (req.path.startsWith('/webhook/')) return next();
    const stats = { removed: 0 };
    if (req.body && typeof req.body === 'object') req.body = clean(req.body, stats);
    // Express 5: req.query is a getter on the prototype, so the cleaned copy is defined on the request itself
    if (req.query && typeof req.query === 'object') {
        const q = clean(req.query, stats);
        Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true, enumerable: true });
    }
    if (stats.removed) {
        securityLog.record(req, { type: 'forbidden', outcome: 'blocked', reason: 'nosql_operator_stripped', meta: { removed: stats.removed } });
    }
    next();
};

// ---------------------------------------------------------------------------
// HTTP parameter pollution: ?status=a&status=b becomes an array. Routes that expect a string fail zod validation
// (400); for the rest the number of repeated values is capped so a request cannot fan out into a huge $in query.
// ---------------------------------------------------------------------------
const MAX_REPEATED = 50;
const parameterPollutionGuard = (req, res, next) => {
    const q = req.query;
    if (q && typeof q === 'object') {
        let changed = false;
        const out = {};
        for (const k of Object.keys(q)) {
            if (Array.isArray(q[k]) && q[k].length > MAX_REPEATED) { out[k] = q[k].slice(0, MAX_REPEATED); changed = true; }
            else out[k] = q[k];
        }
        if (changed) Object.defineProperty(req, 'query', { value: out, writable: true, configurable: true, enumerable: true });
    }
    next();
};

// ---------------------------------------------------------------------------
// Extra response headers (helmet covers the rest). Every response also carries a request id for log correlation.
// ---------------------------------------------------------------------------
const extraHeaders = (req, res, next) => {
    const id = crypto.randomBytes(8).toString('hex');
    req.id = id;
    res.set('X-Request-Id', id);
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    // Signed-in API answers and credential endpoints are per-user data: never let a shared cache keep them
    if (req.path.startsWith('/v1/private') || /^[/]v1[/](public[/])?(login|refresh|verify-otp|logout)/.test(req.path)) res.set('Cache-Control', 'no-store');
    next();
};

module.exports = { sanitizeInput, parameterPollutionGuard, extraHeaders, _clean: clean };
