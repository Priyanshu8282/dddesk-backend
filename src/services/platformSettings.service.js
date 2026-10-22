/**
 * Platform settings (one document, GlobalSetting key `platform_settings`).
 * Every value here is READ by real code paths (see the helpers at the bottom), not just stored:
 *   maintenance  -> auth.middleware + login            registrationEnabled -> public registration
 *   autoApprove  -> registerLibrary                     trial / grace days  -> provisioning + subscription state
 *   urls         -> CORS (additive) and public branding alerts -> platformAlerts.service
 * Secrets (passwords, API keys, the database URL) never live here.
 */
const path = require('path');
const GlobalSetting = require('../models/setting.model');

const KEY = 'platform_settings';
const TTL_MS = 30 * 1000;

const DEFAULTS = Object.freeze({
  general: { platformName: 'DDdesk.ai', tagline: 'Smart workspace for modern libraries', companyName: '', supportEmail: '', supportPhone: '', gstin: '', address: '' },
  branding: { logoPath: null, faviconPath: null, primaryColor: '#1063e0' },
  urls: { frontendUrl: '', backendUrl: '' },
  onboarding: { registrationEnabled: true, autoApproveNewLibraries: false, defaultTrialDays: 14, defaultGraceDays: 7 },
  maintenance: { enabled: false, message: 'DDdesk is being upgraded. Please try again in a little while.' },
  alerts: {
    superAdminEmails: [],
    events: { newRegistration: true, paymentFailed: true, subscriptionSuspended: true, securityAlert: true },
    securityAlertThreshold: 5,
  },
});

let cache = { value: JSON.parse(JSON.stringify(DEFAULTS)), at: 0, loaded: false };

// merge stored over defaults, one level of sections deep (and nested `events`)
const merge = (storedValue) => {
  const stored = storedValue && typeof storedValue === 'object' ? storedValue : {}; // null/undefined = nothing saved yet
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  for (const section of Object.keys(DEFAULTS)) {
    const s = stored[section];
    if (!s || typeof s !== 'object') continue;
    for (const k of Object.keys(DEFAULTS[section])) {
      if (s[k] === undefined) continue;
      if (k === 'events' && typeof s[k] === 'object') out[section][k] = { ...DEFAULTS[section][k], ...s[k] };
      else out[section][k] = s[k];
    }
  }
  return out;
};

const load = async () => {
  const doc = await GlobalSetting.findOne({ key: KEY }).lean();
  cache = { value: merge(doc && doc.value), at: Date.now(), loaded: true };
  return cache.value;
};

/** Cached copy, refreshed when older than the TTL. Never throws (a database hiccup keeps the last good copy). */
const ensureFresh = async () => {
  if (cache.loaded && Date.now() - cache.at < TTL_MS) return cache.value;
  try { return await load(); } catch (_) { cache.at = Date.now(); return cache.value; }
};

/** Synchronous read of the last loaded copy (defaults until the first load). For hot paths. */
const current = () => cache.value;
const invalidate = () => { cache.at = 0; };

exports.DEFAULTS = DEFAULTS;
exports.load = load;
exports.ensureFresh = ensureFresh;
exports.current = current;

exports.getAll = async () => { await load(); return cache.value; };

/** Replace ONE section (already validated by the route). Returns the full merged document. */
exports.updateSection = async (section, value) => {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, section)) throw Object.assign(new Error('Unknown settings section'), { status: 400 });
  await load();
  const next = { ...cache.value, [section]: { ...cache.value[section], ...value } };
  await GlobalSetting.findOneAndUpdate(
    { key: KEY },
    { $set: { value: next, isPublic: false, description: 'Platform settings (general, branding, urls, onboarding, maintenance, alerts)' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  cache = { value: merge(next), at: Date.now(), loaded: true };
  return cache.value;
};

// ---------------------------------------------------------------------------
// Public view (no login): safe fields only
// ---------------------------------------------------------------------------
const uploadUrl = (rel, base) => {
  if (!rel) return null;
  const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  return `${(base || '').replace(/\/+$/, '')}/${clean}`;
};

exports.publicBranding = async (req) => {
  const s = await ensureFresh();
  const host = `${req.protocol}://${req.get('host')}`;
  const base = s.urls.backendUrl || host;
  return {
    platformName: s.general.platformName,
    tagline: s.general.tagline,
    supportEmail: s.general.supportEmail || null,
    supportPhone: s.general.supportPhone || null,
    // Legal details printed on invoices
    companyName: s.general.companyName || null,
    gstin: s.general.gstin || null,
    address: s.general.address || null,
    logoUrl: uploadUrl(s.branding.logoPath, base),
    faviconUrl: uploadUrl(s.branding.faviconPath, base),
    primaryColor: s.branding.primaryColor,
    registrationEnabled: s.onboarding.registrationEnabled,
    maintenance: { enabled: s.maintenance.enabled, message: s.maintenance.enabled ? s.maintenance.message : null },
  };
};

// ---------------------------------------------------------------------------
// Helpers other modules call (all tolerant of "not loaded yet")
// ---------------------------------------------------------------------------
exports.isMaintenance = () => !!current().maintenance.enabled;
exports.maintenanceMessage = () => current().maintenance.message;
exports.registrationOpen = () => current().onboarding.registrationEnabled !== false;
exports.autoApprove = () => !!current().onboarding.autoApproveNewLibraries;
exports.defaultTrialDays = () => Number(current().onboarding.defaultTrialDays);
exports.defaultGraceDays = () => Number(current().onboarding.defaultGraceDays);
exports.alertConfig = () => current().alerts;

/** Origin of the configured frontend URL, allowed by CORS in addition to the env list */
exports.extraAllowedOrigins = () => {
  const out = [];
  for (const u of [current().urls.frontendUrl]) {
    try { if (u) out.push(new URL(u).origin); } catch (_) { /* ignore invalid */ }
  }
  return out;
};

exports.STORAGE_DIR = path.join('uploads', 'branding');
