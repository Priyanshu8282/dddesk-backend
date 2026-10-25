const catchAsync = require('../utils/catchAsync');
const audit = require('../utils/audit');
const securityLog = require('../utils/securityLog');
const svc = require('../services/legal.service');
const system = require('../services/platformSystem.service');

const logChange = (req, action, type, extra = {}) => {
    audit(req, `legal.${action}`, 'LegalDocument', null, { type, ...extra });
    securityLog.record(req, { type: 'legal_change', outcome: 'success', reason: action, userId: req.user?._id || null, userType: req.userType || null, meta: { type, ...extra } });
};

// ---- super admin ----
exports.list = catchAsync(async (req, res) => {
    res.status(200).json({ success: true, message: 'Legal documents retrieved successfully', data: await svc.list() });
});
exports.versions = catchAsync(async (req, res) => {
    res.status(200).json({ success: true, message: 'Versions retrieved successfully', data: await svc.listVersions(req.params.type) });
});
exports.version = catchAsync(async (req, res) => {
    res.status(200).json({ success: true, message: 'Version retrieved successfully', data: await svc.getVersion(req.params.type, req.params.version) });
});
exports.compare = catchAsync(async (req, res) => {
    res.status(200).json({ success: true, message: 'Versions retrieved successfully', data: await svc.compare(req.params.type, req.query.a, req.query.b) });
});
exports.createDraft = catchAsync(async (req, res) => {
    const data = await svc.createDraft(req.params.type, { ...req.body, userId: req.user._id });
    logChange(req, 'draft.create', data.type, { version: data.version, from: req.body.from, sourceVersion: data.sourceVersion });
    res.status(201).json({ success: true, message: 'Draft created', data });
});
exports.saveDraft = catchAsync(async (req, res) => {
    const data = await svc.saveDraft(req.params.type, { ...req.body, userId: req.user._id });
    audit(req, 'legal.draft.save', 'LegalDocument', null, { type: data.type, version: data.version, revision: data.revision });
    res.status(200).json({ success: true, message: 'Draft saved', data });
});
exports.deleteDraft = catchAsync(async (req, res) => {
    const data = await svc.deleteDraft(req.params.type);
    logChange(req, 'draft.delete', data.type, { version: data.version });
    res.status(200).json({ success: true, message: 'Draft deleted' });
});
exports.publish = catchAsync(async (req, res) => {
    await system.verifyPassword(req, req.body.password);
    const { password, ...input } = req.body;
    const data = await svc.publish(req.params.type, { ...input, userId: req.user._id });
    logChange(req, data.live ? 'publish' : 'schedule', data.type, { version: data.version, effectiveFrom: data.effectiveFrom, summaryOfChanges: data.summaryOfChanges });
    res.status(200).json({ success: true, message: data.live ? 'Published' : 'Scheduled', data });
});
exports.cancelSchedule = catchAsync(async (req, res) => {
    const data = await svc.cancelSchedule(req.params.type);
    logChange(req, 'schedule.cancel', data.type, { version: data.version });
    res.status(200).json({ success: true, message: 'Schedule cancelled. The version is a draft again.', data });
});
exports.restore = catchAsync(async (req, res) => {
    const data = await svc.restore(req.params.type, req.params.version, req.user._id);
    logChange(req, 'restore', data.type, { restoredFrom: req.params.version, version: data.version });
    res.status(201).json({ success: true, message: 'Restored as a new draft', data });
});

// ---- public ----
const CACHE = 'public, max-age=60, stale-while-revalidate=300';
const send = (req, res, body, etagSeed, message) => {
    res.set('Cache-Control', CACHE);
    res.set('ETag', `"${etagSeed}"`);
    if (req.fresh) return res.status(304).end();
    return res.status(200).json({ success: true, message, data: body });
};
exports.publicList = catchAsync(async (req, res) => {
    const data = await svc.listPublic();
    send(req, res, data, data.map((d) => `${d.type}:${d.version}:${new Date(d.effectiveFrom).getTime()}`).join('|'), 'Legal documents retrieved successfully');
});
exports.publicOne = catchAsync(async (req, res) => {
    const data = await svc.getPublic(req.params.type);
    send(req, res, data, `${data.checksum || data.version}:${data.version}`, 'Document retrieved successfully');
});
exports.publicVersion = catchAsync(async (req, res) => {
    const data = await svc.getPublicVersion(req.params.type, req.params.version);
    send(req, res, data, `${data.checksum || data.version}:${data.version}`, 'Document retrieved successfully');
});
