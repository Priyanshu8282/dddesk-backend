const SecurityEvent = require('../models/securityEvent.model');
const { describeRequest } = require('./device');

// "priyanshu@gmail.com" -> "pr*******@gmail.com", "9876543210" -> "******3210". Enough to investigate, not enough to leak.
const maskIdentifier = (v) => {
    const s = String(v || '').trim();
    if (!s) return null;
    if (s.includes('@')) {
        const [n, d] = s.split('@');
        return `${n.slice(0, 2)}${'*'.repeat(Math.max(1, n.length - 2))}@${d}`.slice(0, 120);
    }
    const digits = s.replace(/\D/g, '');
    return digits.length >= 6 ? `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}` : s.slice(0, 40);
};

// Repeats of the same blocked event from one address are stored once a minute, so an attacker hammering
// an endpoint cannot flood the database through the log itself.
const THROTTLED = new Set(['rate_limited', 'forbidden']);
const THROTTLE_MS = 60 * 1000;
const lastSeen = new Map();
const throttled = (key) => {
    const now = Date.now();
    if (lastSeen.size > 5000) { for (const [k, t] of lastSeen) if (now - t > THROTTLE_MS) lastSeen.delete(k); }
    const t = lastSeen.get(key);
    if (t && now - t < THROTTLE_MS) return true;
    lastSeen.set(key, now);
    return false;
};

const identifierOf = (body = {}) => body.identifier || body.email || body.mobile || null;

/**
 * Fire-and-forget security event. Never throws and never delays the request.
 * record(req, { type, outcome, reason, identifier, userId, userType, libraryId, meta })
 * Passwords and OTPs are never stored: only the (masked) identifier.
 */
const record = (req, { type, outcome, reason = null, identifier, userId = null, userType = null, libraryId = null, meta = {} }) => {
    try {
        if (THROTTLED.has(type) && throttled(`${type}:${(req && req.ip) || ''}:${String((req && req.originalUrl) || '').split('?')[0]}`)) return;
        const ev = {
            type, outcome, reason,
            identifier: maskIdentifier(identifier !== undefined ? identifier : identifierOf(req && req.body)),
            userId, userType, libraryId,
            ip: describeRequest(req).ip,
            userAgent: describeRequest(req).userAgent,
            device: describeRequest(req).device,
            method: req ? req.method : null,
            path: req ? String(req.originalUrl || '').split('?')[0].slice(0, 200) : null,
            meta,
        };
        SecurityEvent.create(ev).catch((e) => console.error('Security log failed:', e.message));
        watch(ev);
    } catch (e) { console.error('Security log failed:', e.message); }
};

// Several failed sign-ins from one address in 10 minutes raises ONE security alert (threshold from Platform Settings)
const WINDOW_MS = 10 * 60 * 1000;
const failures = new Map(); // ip -> [{ t, who }]
const watch = (ev) => {
    try {
        if (!(ev.type === 'login' || ev.type === 'otp_verify') || ev.outcome === 'success' || !ev.ip || ev.ip === 'unknown') return;
        const now = Date.now();
        if (failures.size > 2000) { for (const [k, v] of failures) if (!v.length || now - v[v.length - 1].t > WINDOW_MS) failures.delete(k); }
        const list = (failures.get(ev.ip) || []).filter((x) => now - x.t < WINDOW_MS);
        list.push({ t: now, who: ev.identifier });
        failures.set(ev.ip, list);
        const threshold = require('../services/platformSettings.service').alertConfig().securityAlertThreshold || 5;
        if (list.length >= threshold) {
            const accounts = [...new Set(list.map((x) => x.who).filter(Boolean))];
            require('../services/platformAlerts.service').notify('securityAlert', {
                message: `${list.length} failed sign-in attempts from ${ev.ip} in the last 10 minutes${accounts.length ? ' (accounts tried: ' + accounts.slice(0, 5).join(', ') + ')' : ''}.`,
                dedupeKey: `ip:${ev.ip}`, data: { ip: ev.ip },
            });
        }
    } catch (_) { /* never break sign-in */ }
};

module.exports = { record, maskIdentifier };
