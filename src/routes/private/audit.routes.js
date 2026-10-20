const express = require('express');
const { z } = require('zod');
const catchAsync = require('../../utils/catchAsync');
const validate = require('../../middlewares/validate.middleware');
const { requireSuperAdmin } = require('../../middlewares/access.middleware');
const { auditQuery } = require('../../validations/library.validation');
const auditService = require('../../services/audit.service');
const sec = require('../../services/securityAudit.service');
const { normalizeIp, parseUserAgent } = require('../../utils/device');

// extra, computed-on-read fields so every row (old or new) carries clean address and device details
const withWhere = (row, ip, ua, device) => ({
    ...row,
    ipInfo: normalizeIp(ip),
    device: device || (ua ? parseUserAgent(ua) : null),
});

const router = express.Router();

router.use(requireSuperAdmin);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const day = z.string().trim().max(40).optional();
const summaryQuery = z.object({ query: z.object({ days: z.coerce.number().int().refine((n) => sec.RANGES.includes(n), 'days must be 7, 30 or 90').optional() }) });
const securityQuery = z.object({ query: z.object({
    type: z.string().trim().max(40).optional(), outcome: z.enum(['all', 'success', 'failure', 'blocked']).optional(),
    ip: z.string().trim().max(64).optional(), libraryId: objectId.optional(), q: z.string().trim().max(80).optional(),
    from: day, to: day, page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(200).optional(),
}) });
const exportQuery = z.object({ query: z.object({
    kind: z.enum(['activity', 'security']).optional(), action: z.string().trim().max(80).optional(), resource: z.string().trim().max(80).optional(),
    type: z.string().trim().max(40).optional(), outcome: z.enum(['all', 'success', 'failure', 'blocked']).optional(), ip: z.string().trim().max(64).optional(),
    libraryId: objectId.optional(), q: z.string().trim().max(80).optional(), from: day, to: day,
}) });

// Platform-wide activity trail with filters: action, resource, userId, libraryId, from, to (YYYY-MM-DD in IST or ISO), page, limit
router.get('/', validate(auditQuery), catchAsync(async (req, res) => {
    const { data, pagination } = await auditService.queryLogs(req.query);
    res.json({ success: true, message: 'Audit logs retrieved successfully', data: data.map((l) => withWhere({ ...l, severity: sec.severityOf(l.action) }, l.ipAddress, l.userAgent, l.device)), pagination });
}));

// Dashboard: totals, daily trend, top actions/users, failure reasons, suspicious addresses (days = 7 | 30 | 90)
router.get('/summary', validate(summaryQuery), catchAsync(async (req, res) => {
    res.json({ success: true, message: 'Audit summary retrieved successfully', data: await sec.summary({ days: req.query.days }) });
}));

// Sign-ins, OTP checks, rate-limit blocks, refused requests, cross-library attempts
router.get('/security', validate(securityQuery), catchAsync(async (req, res) => {
    const { data, pagination } = await sec.listSecurity(req.query);
    res.json({ success: true, message: 'Security events retrieved successfully', data: data.map((e) => withWhere(e, e.ip, e.userAgent, e.device)), pagination });
}));

// One event, for the details page
router.get('/activity/:id', validate(z.object({ params: z.object({ id: objectId }) })), catchAsync(async (req, res) => {
    const { data } = await auditService.queryLogs({ id: req.params.id, limit: 1 });
    if (!data[0]) return res.status(404).json({ success: false, message: 'This event was not found. It may have been removed.' });
    const l = data[0];
    res.json({ success: true, data: withWhere({ ...l, severity: sec.severityOf(l.action) }, l.ipAddress, l.userAgent, l.device) });
}));

router.get('/security/:id', validate(z.object({ params: z.object({ id: objectId }) })), catchAsync(async (req, res) => {
    const e = await sec.getSecurityEvent(req.params.id);
    if (!e) return res.status(404).json({ success: false, message: 'This event was not found. It may have been removed.' });
    res.json({ success: true, data: withWhere(e, e.ip, e.userAgent, e.device) });
}));

// Action names for the filter dropdown
router.get('/actions', catchAsync(async (req, res) => {
    res.json({ success: true, data: await sec.activityActions() });
}));

// CSV of the whole filtered set (up to 50,000 rows): ?kind=activity|security plus the same filters
router.get('/export', validate(exportQuery), catchAsync(async (req, res) => {
    const kind = req.query.kind === 'security' ? 'security' : 'activity';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${kind}-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    await sec.exportCsv(kind, req.query, (chunk) => new Promise((resolve) => (res.write(chunk) ? resolve() : res.once('drain', resolve))));
    res.end();
}));

module.exports = router;
