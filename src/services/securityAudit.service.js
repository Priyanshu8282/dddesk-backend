/**
 * Read side of the Audit & Security module: dashboard summary, security event search, CSV export.
 * Activity (AuditLog) = what known users did. Security events (SecurityEvent) = sign-ins, blocks, refusals.
 * Built for a distant database: every call is a handful of parallel queries.
 */
const mongoose = require('mongoose');
const AuditLog = require('../models/auditLog.model');
const SecurityEvent = require('../models/securityEvent.model');
const Admin = require('../models/admin.model');
const Library = require('../models/library.model');
const escapeRegex = require('../utils/escapeRegex');
const { normalizeIp, parseUserAgent } = require('../utils/device');
const { startOfDayIST, endOfDayIST, IST_OFFSET_MS, DAY_MS } = require('../utils/time');

const TZ = 'Asia/Kolkata';
const RANGES = [7, 30, 90];
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// How serious an activity is, from its action name. Used for filtering and badges.
const CRITICAL = /(delete|suspend|reject|impersonat|password|disable|archive|role|permission|slug|refund|cancel|security\.)/i;
const WARNING = /(update|status|assign|approve|reinstate|plan|waive|adjust|transfer|release)/i;
const severityOf = (action) => (CRITICAL.test(action || '') ? 'critical' : WARNING.test(action || '') ? 'warning' : 'info');

const parseBound = (v, end) => {
    if (!v) return null;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? (end ? endOfDayIST(v) : startOfDayIST(v)) : new Date(v);
    return isNaN(d) ? null : d;
};
const dayKey = (d) => { const s = new Date(new Date(d).getTime() + IST_OFFSET_MS); return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}-${String(s.getUTCDate()).padStart(2, '0')}`; };
const sinceDays = (days) => startOfDayIST(new Date(Date.now() - (days - 1) * DAY_MS));

exports.RANGES = RANGES;
exports.severityOf = severityOf;

/** Dashboard numbers for the last `days` days (IST calendar days) */
exports.summary = async ({ days = 7 } = {}) => {
    const range = RANGES.includes(Number(days)) ? Number(days) : 7;
    const from = sinceDays(range);
    const byDayPart = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } }; // one group per IST day

    const [act, sec, failedByIp] = await Promise.all([
        AuditLog.aggregate([
            { $match: { createdAt: { $gte: from } } },
            { $facet: {
                total: [{ $count: 'n' }],
                byDay: [{ $group: { _id: byDayPart, n: { $sum: 1 } } }],
                topActions: [{ $group: { _id: '$action', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }],
                byUserType: [{ $group: { _id: '$userType', n: { $sum: 1 } } }],
                topUsers: [{ $match: { userType: { $ne: 'system' } } }, { $group: { _id: '$userId', n: { $sum: 1 }, userType: { $first: '$userType' } } }, { $sort: { n: -1 } }, { $limit: 5 }],
                critical: [{ $match: { action: { $regex: CRITICAL.source, $options: 'i' } } }, { $count: 'n' }],
            } },
        ]),
        SecurityEvent.aggregate([
            { $match: { createdAt: { $gte: from } } },
            { $facet: {
                byDay: [{ $group: { _id: { d: byDayPart, k: { $concat: ['$type', ':', '$outcome'] } }, n: { $sum: 1 } } }],
                byKind: [{ $group: { _id: { type: '$type', outcome: '$outcome' }, n: { $sum: 1 } } }],
                reasons: [{ $match: { outcome: { $ne: 'success' } } }, { $group: { _id: '$reason', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 6 }],
            } },
        ]),
        // addresses with several failures: the likely guessers
        SecurityEvent.aggregate([
            { $match: { createdAt: { $gte: from }, outcome: { $in: ['failure', 'blocked'] } } },
            { $group: { _id: '$ip', failures: { $sum: 1 }, identifiers: { $addToSet: '$identifier' }, last: { $max: '$createdAt' }, types: { $addToSet: '$type' } } },
            { $match: { failures: { $gte: 3 } } }, { $sort: { failures: -1 } }, { $limit: 8 },
        ]),
    ]);

    const a = act[0] || {}; const s = sec[0] || {};
    const days0 = [];
    for (let i = range - 1; i >= 0; i--) days0.push(dayKey(new Date(Date.now() - i * DAY_MS)));
    const actByDay = new Map((a.byDay || []).map((r) => [r._id, r.n]));
    const secByDay = new Map();
    (s.byDay || []).forEach((r) => { const k = r._id.d; const m = secByDay.get(k) || {}; m[r._id.k] = r.n; secByDay.set(k, m); });
    const trend = days0.map((k) => {
        const m = secByDay.get(k) || {};
        return { date: k, activity: actByDay.get(k) || 0, loginSuccess: m['login:success'] || 0, loginFailed: (m['login:failure'] || 0) + (m['login:blocked'] || 0) + (m['otp_verify:failure'] || 0), blocked: (m['rate_limited:blocked'] || 0) + (m['forbidden:blocked'] || 0) + (m['tenant_mismatch:blocked'] || 0) };
    });

    const kind = (t, o) => ((s.byKind || []).find((r) => r._id.type === t && r._id.outcome === o) || {}).n || 0;
    const loginOk = kind('login', 'success');
    const loginFailed = kind('login', 'failure') + kind('login', 'blocked') + kind('otp_verify', 'failure') + kind('otp_verify', 'blocked');

    // names for the most active users
    const topIds = (a.topUsers || []).map((u) => u._id).filter(Boolean);
    const people = topIds.length ? await Admin.find({ _id: { $in: topIds } }).select('name email').lean() : [];
    const nameOf = new Map(people.map((p) => [String(p._id), p]));

    return {
      range: { days: range, from, to: new Date() },
      totals: {
        activity: (a.total && a.total[0] && a.total[0].n) || 0,
        criticalActivity: (a.critical && a.critical[0] && a.critical[0].n) || 0,
        loginSuccess: loginOk, loginFailed,
        failureRatePct: loginOk + loginFailed ? Math.round((loginFailed / (loginOk + loginFailed)) * 1000) / 10 : null,
        rateLimited: kind('rate_limited', 'blocked'),
        forbidden: kind('forbidden', 'blocked'),
        crossLibraryAttempts: kind('tenant_mismatch', 'blocked'),
        passwordResets: kind('password_reset', 'success'),
        suspiciousAddresses: failedByIp.length,
      },
      trend,
      topActions: (a.topActions || []).map((r) => ({ action: r._id, count: r.n, severity: severityOf(r._id) })),
      byUserType: (a.byUserType || []).map((r) => ({ userType: r._id, count: r.n })),
      topUsers: (a.topUsers || []).map((u) => ({ userId: u._id, count: u.n, userType: u.userType, name: nameOf.get(String(u._id))?.name || null, email: nameOf.get(String(u._id))?.email || null })),
      failureReasons: (s.reasons || []).map((r) => ({ reason: r._id || 'unknown', count: r.n })),
      suspicious: failedByIp.map((r) => ({ ip: r._id, failures: r.failures, accountsTried: (r.identifiers || []).filter(Boolean).length, types: r.types, lastSeen: r.last })),
      generatedAt: new Date(),
    };
};

// ---------------------------------------------------------------------------
// Security event search
// ---------------------------------------------------------------------------
const securityFilter = (q = {}) => {
    const f = {};
    if (q.type && q.type !== 'all') f.type = String(q.type);
    if (q.outcome && q.outcome !== 'all') f.outcome = String(q.outcome);
    if (q.ip) f.ip = String(q.ip).trim();
    if (q.libraryId && mongoose.isValidObjectId(q.libraryId)) f.libraryId = oid(q.libraryId);
    const gte = parseBound(q.from, false), lte = parseBound(q.to, true);
    if (gte || lte) f.createdAt = { ...(gte && { $gte: gte }), ...(lte && { $lte: lte }) };
    if (q.q && String(q.q).trim()) {
        const re = new RegExp(escapeRegex(String(q.q).trim()), 'i');
        f.$or = [{ identifier: re }, { ip: re }, { path: re }, { reason: re }];
    }
    return f;
};

exports.listSecurity = async (q = {}) => {
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 25));
    const f = securityFilter(q);
    const [rows, total] = await Promise.all([
        SecurityEvent.find(f).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        SecurityEvent.countDocuments(f),
    ]);
    const libIds = [...new Set(rows.map((r) => r.libraryId && String(r.libraryId)).filter(Boolean))];
    const libs = libIds.length ? await Library.find({ _id: { $in: libIds } }).select('name').lean() : [];
    const libName = new Map(libs.map((l) => [String(l._id), l.name]));
    return {
        data: rows.map((r) => ({ ...r, libraryName: r.libraryId ? libName.get(String(r.libraryId)) || null : null })),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    };
};

exports.getSecurityEvent = async (id) => {
    const r = await SecurityEvent.findById(id).lean();
    if (!r) return null;
    const lib = r.libraryId ? await Library.findById(r.libraryId).select('name').lean() : null;
    return { ...r, libraryName: lib ? lib.name : null };
};

exports.activityActions = async () => {
    const rows = await AuditLog.aggregate([{ $group: { _id: '$action', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 300 }]);
    return rows.map((r) => ({ action: r._id, count: r.n, severity: severityOf(r._id) }));
};

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
const csvCell = (v) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

exports.exportCsv = async (kind, q, write) => {
    let n = 0;
    if (kind === 'security') {
        await write('﻿' + ['Time', 'Event', 'Result', 'Reason', 'Who (masked)', 'User type', 'Library', 'IP address', 'Address type', 'Device', 'Method', 'Path', 'Browser string', 'Details'].map(csvCell).join(',') + '\n');
        const cursor = SecurityEvent.find(securityFilter(q)).sort({ createdAt: -1 }).limit(50000).lean().cursor();
        for await (const r of cursor) { await write([r.createdAt, r.type, r.outcome, r.reason, r.identifier, r.userType, r.libraryId, normalizeIp(r.ip).ip, normalizeIp(r.ip).kind, (r.device || parseUserAgent(r.userAgent)).summary, r.method, r.path, r.userAgent, r.meta].map(csvCell).join(',') + '\n'); n++; }
        return n;
    }
    const f = {};
    if (q.action) f.action = String(q.action).endsWith('*') ? { $regex: '^' + escapeRegex(String(q.action).slice(0, -1)) } : String(q.action);
    if (q.resource) f.resource = String(q.resource);
    if (q.libraryId && mongoose.isValidObjectId(q.libraryId)) f.libraryId = oid(q.libraryId);
    const gte = parseBound(q.from, false), lte = parseBound(q.to, true);
    if (gte || lte) f.createdAt = { ...(gte && { $gte: gte }), ...(lte && { $lte: lte }) };
    await write('﻿' + ['Time', 'Action', 'Severity', 'Resource', 'Resource id', 'User id', 'User type', 'Library', 'IP address', 'Address type', 'Device', 'Details'].map(csvCell).join(',') + '\n');
    const cursor = AuditLog.find(f).sort({ createdAt: -1 }).limit(50000).lean().cursor();
    for await (const r of cursor) { await write([r.createdAt, r.action, severityOf(r.action), r.resource, r.resourceId, r.userId, r.userType, r.libraryId, normalizeIp(r.ipAddress).ip, normalizeIp(r.ipAddress).kind, (r.device || parseUserAgent(r.userAgent)).summary, r.metadata].map(csvCell).join(',') + '\n'); n++; }
    return n;
};
