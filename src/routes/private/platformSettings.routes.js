const express = require('express');
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const catchAsync = require('../../utils/catchAsync');
const ApiError = require('../../utils/ApiError');
const audit = require('../../utils/audit');
const validate = require('../../middlewares/validate.middleware');
const upload = require('../../middlewares/upload.middleware');
const { requireSuperAdmin } = require('../../middlewares/access.middleware');
const settings = require('../../services/platformSettings.service');
const system = require('../../services/platformSystem.service');
const providerConfig = require('../../services/notificationProviderConfig.service');

const router = express.Router();
router.use(requireSuperAdmin);

// ---------------------------------------------------------------------------
// Validation (one schema per section; the whole section is replaced with the validated values)
// ---------------------------------------------------------------------------
const optText = (max) => z.string().trim().max(max);
const optEmail = z.union([z.literal(''), z.string().trim().toLowerCase().email().max(120)]);
const optUrl = z.union([z.literal(''), z.string().trim().max(200).refine((u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch (_) { return false; } }, 'Enter a full address like https://app.example.com')]);
const phone = z.union([z.literal(''), z.string().trim().regex(/^(\+?91[\s-]?)?[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number')]);
const gstin = z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN')]);

const SECTIONS = {
  general: z.object({
    platformName: z.string().trim().min(2).max(60), tagline: optText(120), companyName: optText(120),
    supportEmail: optEmail, supportPhone: phone, gstin, address: optText(300),
  }).partial(),
  branding: z.object({ primaryColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1063e0') }).partial(),
  urls: z.object({ frontendUrl: optUrl, backendUrl: optUrl }).partial(),
  onboarding: z.object({
    registrationEnabled: z.boolean(), autoApproveNewLibraries: z.boolean(),
    defaultTrialDays: z.coerce.number().int().min(0).max(365), defaultGraceDays: z.coerce.number().int().min(0).max(90),
  }).partial(),
  maintenance: z.object({ enabled: z.boolean(), message: z.string().trim().min(3).max(300) }).partial(),
  alerts: z.object({
    superAdminEmails: z.array(z.string().trim().toLowerCase().email()).max(10),
    events: z.object({ newRegistration: z.boolean(), paymentFailed: z.boolean(), subscriptionSuspended: z.boolean(), securityAlert: z.boolean() }).partial(),
    securityAlertThreshold: z.coerce.number().int().min(3).max(100),
  }).partial(),
};
const sectionParams = z.object({ section: z.enum(Object.keys(SECTIONS)) });

const IMPERSONATION = 'Settings cannot be changed during a support session';

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
// GET /super/platform-settings : every section + environment summary (no secrets)
router.get('/', catchAsync(async (req, res) => {
  const [all] = await Promise.all([settings.getAll(), providerConfig.ensureFresh().catch(() => {})]);
  res.json({ success: true, message: 'Platform settings retrieved successfully', data: { ...all, environment: system.environmentInfo() } });
}));

// GET /super/platform-settings/health : server, database and integration checks
router.get('/health', catchAsync(async (req, res) => {
  res.json({ success: true, message: 'System health retrieved successfully', data: await system.health() });
}));

// ---------------------------------------------------------------------------
// Save a section
// ---------------------------------------------------------------------------
router.put('/section/:section', catchAsync(async (req, res) => {
  if (req.impersonatedBy) throw new ApiError(403, IMPERSONATION);
  const { section } = sectionParams.parse({ section: req.params.section });
  const parsed = SECTIONS[section].safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(400, `${issue.path.join('.') || section}: ${issue.message}`);
  }
  if (!Object.keys(parsed.data).length) throw new ApiError(400, 'Nothing to save');
  if (section === 'maintenance' && parsed.data.enabled === true && !(parsed.data.message || settings.current().maintenance.message)) throw new ApiError(400, 'Write a message for visitors first');
  if (section === 'general' && parsed.data.supportPhone) parsed.data.supportPhone = require('../../utils/mobile').normalizeMobile(parsed.data.supportPhone);
  const next = await settings.updateSection(section, parsed.data);
  await audit(req, `platform_settings.${section}`, 'GlobalSetting', null, { fields: Object.keys(parsed.data), ...(section === 'maintenance' ? { enabled: next.maintenance.enabled } : {}) });
  res.json({ success: true, message: 'Settings saved', data: next[section] });
}));

// ---------------------------------------------------------------------------
// Logo and favicon (PNG, JPG, WEBP or GIF up to 5 MB; SVG is refused because it can carry scripts)
// ---------------------------------------------------------------------------
const rel = (file) => path.relative(process.cwd(), path.resolve(file.path)).replace(/\\/g, '/');
const removeFile = (p) => {
  if (!p) return;
  const abs = path.resolve(process.cwd(), p);
  if (!abs.startsWith(path.resolve(process.cwd(), 'uploads') + path.sep)) return;
  try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch (_) { /* ignore */ }
};

const brandingUpload = (field, prop) => [
  upload.single(field),
  catchAsync(async (req, res) => {
    if (req.impersonatedBy) { if (req.file) removeFile(rel(req.file)); throw new ApiError(403, IMPERSONATION); }
    if (!req.file) throw new ApiError(400, 'Choose an image file');
    if (req.file.mediaKind !== 'image') { removeFile(rel(req.file)); throw new ApiError(400, 'Please upload a PNG, JPG, WEBP or GIF image'); }
    const old = settings.current().branding[prop];
    const next = await settings.updateSection('branding', { [prop]: rel(req.file) });
    if (old && old !== rel(req.file)) removeFile(old);
    await audit(req, `platform_settings.${prop === 'logoPath' ? 'logo' : 'favicon'}_upload`, 'GlobalSetting', null, {});
    res.json({ success: true, message: prop === 'logoPath' ? 'Logo updated' : 'Favicon updated', data: next.branding });
  }),
];
router.post('/logo', ...brandingUpload('platformLogo', 'logoPath'));
router.post('/favicon', ...brandingUpload('platformFavicon', 'faviconPath'));

const brandingRemove = (prop, label) => catchAsync(async (req, res) => {
  if (req.impersonatedBy) throw new ApiError(403, IMPERSONATION);
  const old = settings.current().branding[prop];
  const next = await settings.updateSection('branding', { [prop]: null });
  removeFile(old);
  await audit(req, `platform_settings.${label}_remove`, 'GlobalSetting', null, {});
  res.json({ success: true, message: `${label === 'logo' ? 'Logo' : 'Favicon'} removed`, data: next.branding });
});
router.delete('/logo', brandingRemove('logoPath', 'logo'));
router.delete('/favicon', brandingRemove('faviconPath', 'favicon'));

// ---------------------------------------------------------------------------
// Test e-mail (uses whatever e-mail provider is configured right now)
// ---------------------------------------------------------------------------
router.post('/test-email', validate(z.object({ body: z.object({ to: z.string().trim().toLowerCase().email() }) })), catchAsync(async (req, res) => {
  const { sendPlatformEmail } = require('../../services/notification.service');
  const name = settings.current().general.platformName;
  const r = await sendPlatformEmail(req.body.to, `${name}: test e-mail`, `This is a test e-mail from ${name}. If you can read it, e-mail sending works.`);
  res.json({ success: r.status === 'sent', message: r.status === 'sent' ? `Test e-mail sent to ${req.body.to}` : r.status === 'skipped' ? 'E-mail is not configured yet, so nothing was sent' : `Sending failed: ${r.error}`, data: r });
}));

// ---------------------------------------------------------------------------
// Database + environment
// ---------------------------------------------------------------------------
router.get('/database', catchAsync(async (req, res) => {
  res.json({ success: true, data: await system.databaseStatus() });
}));

// Try a connection string without saving anything
router.post('/database/test', validate(z.object({ body: z.object({ url: z.string().trim().min(10).max(1000) }) })), catchAsync(async (req, res) => {
  const r = await system.testDatabase(req.body.url);
  res.json({ success: r.ok, message: r.ok ? 'Connection works' : 'Could not connect', data: r });
}));

// Change one environment value (needs your password; a new database URL is test-connected first)
router.put('/environment', validate(z.object({ body: z.object({
  key: z.enum(system.EDITABLE_KEYS), value: z.string().trim().min(1).max(1000), password: z.string().min(1, 'Enter your password to confirm'),
}) })), catchAsync(async (req, res) => {
  const r = await system.saveEnvironment(req, req.body);
  // the audit trail records WHAT changed, never the value of a secret
  await audit(req, 'platform_settings.environment', 'GlobalSetting', null, { key: r.key, backup: r.backup, ...(r.key === 'MONGODB_URL' ? { to: r.valueMasked } : { to: r.valueMasked }) });
  res.json({ success: true, message: 'Saved to the server settings file. Restart the server for it to take effect.', data: r });
}));

module.exports = router;
