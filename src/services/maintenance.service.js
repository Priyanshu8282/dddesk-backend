/**
 * Maintenance mode: reading the current state on hot paths, and the super admin's controls to change it.
 * The rules themselves (is it active, does it apply to this request) are pure functions in utils/maintenance.js.
 *
 * Time-based switching needs no cron: every check compares the stored start/end times with the clock, so a
 * scheduled window starts and ends by itself on every server instance (including serverless ones).
 */
const mongoose = require('mongoose');
const rules = require('../utils/maintenance');
const settings = require('./platformSettings.service');
const MaintenanceEvent = require('../models/maintenanceEvent.model');
const PlatformAnnouncement = require('../models/platformAnnouncement.model');
const Admin = require('../models/admin.model');
const Notification = require('../models/notification.model');
const audit = require('../utils/audit');
const securityLog = require('../utils/securityLog');
const { describeRequest } = require('../utils/device');

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const fresh = () => settings.ensureFresh(settings.MAINTENANCE_TTL_MS);

const ipOf = (req) => {
  try { return describeRequest(req).ip; } catch (_) { return req && req.ip; }
};

// ---------------------------------------------------------------------------
// Hot-path reads
// ---------------------------------------------------------------------------
/** Normalised config as stored right now (sync, last loaded copy). */
const config = () => rules.normalize(settings.current().maintenance);

/**
 * Should this request be refused? ctx: { method, userType, userId, libraryId, ip }
 * Returns the 503 body, or null when the request may go on. Never throws: if settings cannot be read the
 * last good copy is used, and with nothing loaded the answer is "not in maintenance".
 */
const check = async (ctx) => {
  await fresh();
  const cfg = settings.current().maintenance;
  return rules.blocks(cfg, ctx) ? rules.blockedBody(cfg) : null;
};

/** Send the standard 503 answer. */
const sendBlocked = (res, body) => {
  res.set('Retry-After', String(body.retryAfter));
  res.set('Cache-Control', 'no-store');
  return res.status(503).json(body);
};

/** Public view (no ids, no internal reason). */
const publicStatus = async () => {
  await fresh();
  return rules.publicView(settings.current().maintenance);
};

/** Scheduled jobs call this first: true = skip this run. */
const cronsPaused = async () => {
  await fresh();
  return rules.cronsPaused(settings.current().maintenance);
};

// ---------------------------------------------------------------------------
// Super admin view
// ---------------------------------------------------------------------------
const view = async (limit = 20) => {
  await fresh();
  const cfg = config();
  const raw = settings.current().maintenance;
  const history = await MaintenanceEvent.find().sort({ createdAt: -1 }).limit(Math.min(Math.max(Number(limit) || 20, 1), 100)).lean();
  return {
    config: cfg,
    phase: rules.phase(raw),
    forcedOff: rules.forcedOff(),
    now: new Date().toISOString(),
    limits: { maxWindowHours: rules.MAX_WINDOW_MS / 3600000 },
    history: history.map((h) => ({
      id: h._id, action: h.action, mode: h.mode, scope: h.scope, libraryCount: h.libraryCount, message: h.message, reason: h.reason,
      startsAt: h.startsAt, endsAt: h.endsAt, estimatedBackAt: h.estimatedBackAt, pauseCrons: h.pauseCrons, notified: h.notified,
      by: h.by, byName: h.byName, at: h.createdAt,
    })),
  };
};

// ---------------------------------------------------------------------------
// Change the state
// ---------------------------------------------------------------------------
const fmtIst = (v) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST' : null);

const OWNER_CAP = 5000;
/** Tell libraries: a platform announcement (shown by anything that lists /announcements/active) + an in-app notice to each owner. */
const notifyLibraries = async (value) => {
  const lines = [value.message];
  if (value.mode === 'scheduled') lines.push(`From ${fmtIst(value.startsAt)} to ${fmtIst(value.endsAt)}.`);
  else if (value.estimatedBackAt || value.endsAt) lines.push(`Expected back by ${fmtIst(value.estimatedBackAt || value.endsAt)}.`);
  if (value.scope === 'readOnly') lines.push('You will be able to view your data but not change it.');
  const body = lines.join(' ');
  const title = value.mode === 'scheduled' ? 'Scheduled maintenance' : 'Maintenance in progress';
  const endsAt = value.endsAt || value.estimatedBackAt || new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  await PlatformAnnouncement.create({
    title, body, audience: 'all', severity: 'warning', startsAt: new Date(), endsAt: new Date(endsAt), isActive: true, createdBy: value.createdBy,
  });

  const filter = { userType: 'admin', status: true, isDeleted: { $ne: true } };
  if (value.scope === 'libraries') filter.libraryId = { $in: value.libraryIds.map((id) => new mongoose.Types.ObjectId(id)) };
  const owners = await Admin.find(filter).select('_id libraryId').limit(OWNER_CAP).lean();
  let sent = 0;
  for (let i = 0; i < owners.length; i += 500) {
    const chunk = owners.slice(i, i + 500);
    await Notification.insertMany(chunk.map((o) => ({
      recipientId: o._id, recipientType: 'Admin', ...(o.libraryId ? { libraryId: o.libraryId } : {}),
      type: 'platform_announcement', event: 'maintenance', title, message: body,
      data: { event: 'maintenance', mode: value.mode, startsAt: String(value.startsAt || ''), endsAt: String(value.endsAt || '') },
      deliveries: [{ channel: 'inapp', status: 'sent' }],
    })), { ordered: false });
    sent += chunk.length;
  }
  return { owners: sent, capped: owners.length >= OWNER_CAP };
};

const record = async (req, action, value, extra = {}) => {
  const actor = req.user || {};
  await MaintenanceEvent.create({
    action, mode: value.mode || null, scope: value.scope || null, libraryCount: (value.libraryIds || []).length,
    message: value.message || null, reason: value.reason || null,
    startsAt: value.startsAt || null, endsAt: value.endsAt || null, estimatedBackAt: value.estimatedBackAt || null,
    pauseCrons: !!value.pauseCrons, notified: !!extra.notified,
    by: actor._id || null, byName: actor.name || actor.email || null, ip: ipOf(req) || null,
  }).catch((e) => console.error('[maintenance] history write failed:', e.message));
  audit(req, `maintenance.${action}`, 'GlobalSetting', null, {
    mode: value.mode, scope: value.scope, libraries: (value.libraryIds || []).length, startsAt: value.startsAt, endsAt: value.endsAt, pauseCrons: !!value.pauseCrons, reason: value.reason,
  }).catch(() => {});
  securityLog.record(req, {
    type: 'maintenance', outcome: 'success', reason: action, userId: actor._id || null, userType: req.userType || 'superadmin', identifier: actor.email || null,
    meta: { mode: value.mode, scope: value.scope, startsAt: value.startsAt, endsAt: value.endsAt },
  });
};

const persist = async (req, value) => {
  const actor = req.user || {};
  const next = await settings.updateSection('maintenance', {
    ...value,
    enabled: value.mode === 'on',
    updatedAt: new Date().toISOString(), updatedBy: actor._id ? String(actor._id) : null, updatedByName: actor.name || actor.email || null,
  });
  return rules.normalize(next.maintenance);
};

/**
 * action: 'enable' (start now) | 'schedule' | 'update' (change the running/scheduled window) | 'disable' | 'cancel'
 * The caller (route) has already checked the super admin and re-checked the password for enable/schedule/update.
 */
const apply = async (req, input) => {
  if (req.impersonatedBy) throw err('Not allowed during a support session', 403);
  await settings.load(); // read the freshest stored copy before deciding
  const current = settings.current().maintenance;
  const phase = rules.phase(current);
  const action = input.action;

  if (action === 'disable' || action === 'cancel') {
    const cfg = rules.normalize(current);
    if (cfg.mode === 'off') throw err('Maintenance is already off');
    const label = phase === 'upcoming' || action === 'cancel' ? 'cancel' : 'disable';
    const next = await persist(req, { ...cfg, mode: 'off', startsAt: null, endsAt: null, estimatedBackAt: null });
    await record(req, label, { ...cfg, mode: cfg.mode });
    return { config: next, phase: rules.phase(next) };
  }

  let useAction = action;
  if (action === 'update') {
    const cfg = rules.normalize(current);
    if (cfg.mode === 'off') throw err('There is no maintenance window to update');
    useAction = cfg.mode === 'scheduled' ? 'schedule' : 'enable';
  }
  const checked = rules.validateWindow(input, useAction);
  if (!checked.ok) throw err(checked.error);
  const value = { ...checked.value, createdBy: req.user._id };

  // a library-only window must name libraries that exist
  if (value.scope === 'libraries') {
    const Library = require('../models/library.model');
    if (value.libraryIds.some((id) => !/^[0-9a-fA-F]{24}$/.test(id))) throw err('One of the chosen libraries is not valid');
    const found = await Library.countDocuments({ _id: { $in: value.libraryIds }, isDeleted: { $ne: true } });
    if (found !== value.libraryIds.length) throw err('One or more chosen libraries were not found');
  }

  const { createdBy, ...stored } = value;
  const next = await persist(req, stored);
  let notice = null;
  if (input.notifyUsers) {
    try { notice = await notifyLibraries(value); } catch (e) { console.error('[maintenance] notify failed:', e.message); notice = { error: 'Saved, but the notices could not be sent' }; }
  }
  await record(req, action === 'update' ? 'update' : (useAction === 'schedule' ? 'schedule' : 'enable'), stored, { notified: !!(notice && !notice.error) });
  return { config: next, phase: rules.phase(next), notice };
};

/** One log line at start-up so the state is visible in the server log. */
const logStartup = () => {
  try {
    const cfg = config();
    const phase = rules.phase(settings.current().maintenance);
    if (rules.forcedOff()) {
      console.warn(`[maintenance] MAINTENANCE_FORCE_OFF=true: all maintenance rules are switched off (stored mode: ${cfg.mode}). Remove it once you no longer need it.`);
    } else if (cfg.mode === 'off') {
      console.log('[maintenance] off');
    } else {
      console.log(`[maintenance] mode=${cfg.mode} phase=${phase} scope=${cfg.scope} startsAt=${cfg.startsAt || '-'} endsAt=${cfg.endsAt || '-'}`);
    }
  } catch (_) { /* never block start-up */ }
};

module.exports = { config, check, sendBlocked, publicStatus, cronsPaused, view, apply, logStartup };

// ---- Live dashboards: connected apps re-read the public maintenance status (no-op without sockets, never throws) ----
const realtime = require('../realtime/emitters');
module.exports.apply = realtime.after(module.exports.apply, () => realtime.maintenanceChanged());
