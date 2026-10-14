const catchAsync = require('../utils/catchAsync');
const audit = require('../utils/audit');
const svc = require('../services/platformAdmin.service');
const providerCfg = require('../services/notificationProviderConfig.service');

// ---- announcements ----
exports.createAnnouncement = catchAsync(async (req, res) => {
    const data = await svc.createAnnouncement(req);
    audit(req, 'announcement.create', 'PlatformAnnouncement', data._id, { title: data.title, audience: data.audience });
    res.status(201).json({ success: true, message: 'Announcement created', data });
});
exports.listAnnouncements = catchAsync(async (req, res) => {
    const r = await svc.listAnnouncements(req.query);
    res.status(200).json({ success: true, message: 'Announcements retrieved successfully', ...r });
});
exports.getAnnouncement = catchAsync(async (req, res) => {
    const data = await svc.getAnnouncement(req.params.id);
    res.status(200).json({ success: true, message: 'Announcement retrieved successfully', data });
});
exports.updateAnnouncement = catchAsync(async (req, res) => {
    const data = await svc.updateAnnouncement(req.params.id, req.body);
    audit(req, 'announcement.update', 'PlatformAnnouncement', data._id, { fields: Object.keys(req.body) });
    res.status(200).json({ success: true, message: 'Announcement updated', data });
});
exports.deleteAnnouncement = catchAsync(async (req, res) => {
    const data = await svc.deleteAnnouncement(req.params.id);
    audit(req, 'announcement.delete', 'PlatformAnnouncement', data._id, { title: data.title });
    res.status(200).json({ success: true, message: 'Announcement deleted' });
});
// any authenticated user: GET /announcements/active
exports.activeAnnouncements = catchAsync(async (req, res) => {
    const data = await svc.activeFor(req.userType);
    res.status(200).json({ success: true, message: 'Announcements retrieved successfully', data });
});

// ---- notification providers ----
exports.getProviders = catchAsync(async (req, res) => {
    await providerCfg.loadProviderConfig();
    res.status(200).json({ success: true, message: 'Notification providers retrieved successfully', data: providerCfg.maskForResponse(providerCfg.getStoredConfig()) });
});
exports.updateProviders = catchAsync(async (req, res) => {
    const previous = await providerCfg.loadProviderConfig();
    const next = providerCfg.mergeConfig(previous, req.body);
    await providerCfg.saveConfig(next);
    audit(req, 'notification_providers.update', 'GlobalSetting', null, { channels: Object.keys(req.body) });
    res.status(200).json({ success: true, message: 'Notification providers updated', data: providerCfg.maskForResponse(next) });
});

// ---- system events ----
exports.systemEvents = catchAsync(async (req, res) => {
    const data = await svc.systemEvents({ limit: req.query.limit, days: req.query.days });
    res.status(200).json({ success: true, message: 'System events retrieved successfully', data });
});
