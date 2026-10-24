/**
 * Maintenance mode rules. PURE functions (no database, no Express): everything that decides "is the platform in
 * maintenance, and does it apply to this request?" lives here so it can be tested on its own.
 *
 * Config shape (stored in Platform Settings, section `maintenance`):
 *   mode            'off' | 'scheduled' | 'on'
 *   message         shown to visitors
 *   startsAt/endsAt ISO strings (UTC). scheduled: window [startsAt, endsAt). on: endsAt (optional) ends it automatically
 *   estimatedBackAt ISO string, shown to visitors and used for Retry-After
 *   scope           'all' | 'readOnly' | 'libraries'
 *   libraryIds      scope 'libraries': only these libraries are blocked
 *   allowUserIds    extra accounts that keep working (super admins ALWAYS keep working)
 *   allowIps        extra IP addresses that keep working
 *   pauseCrons      skip scheduled jobs while the window is active
 *   reason          internal note (never shown publicly)
 *
 * Old data only had { enabled, message }: `enabled: true` is read as mode 'on'.
 */
const net = require('net');

const MODES = ['off', 'scheduled', 'on'];
const SCOPES = ['all', 'readOnly', 'libraries'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_WINDOW_MS = 72 * 3600 * 1000;      // a window longer than 3 days is almost certainly a mistake
const MAX_AHEAD_MS = 90 * 24 * 3600 * 1000;  // do not schedule more than 90 days ahead
const PAST_TOLERANCE_MS = 60 * 1000;          // clock drift between browser and server
const DEFAULT_MESSAGE = 'DDdesk is being upgraded. Please try again in a little while.';

const toMs = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const uniq = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x).trim()).filter(Boolean))];

/** Break-glass: MAINTENANCE_FORCE_OFF=true in the server environment switches every maintenance rule off. */
const forcedOff = (env = process.env) => String(env.MAINTENANCE_FORCE_OFF || '').toLowerCase() === 'true';

/** Stored config (possibly old-format or partial) -> full, safe config. */
const normalize = (raw) => {
  const c = raw && typeof raw === 'object' ? raw : {};
  let mode = MODES.includes(c.mode) ? c.mode : (c.enabled ? 'on' : 'off');
  const scope = SCOPES.includes(c.scope) ? c.scope : 'all';
  return {
    mode,
    enabled: mode === 'on', // kept for older readers
    message: typeof c.message === 'string' && c.message.trim() ? c.message.trim().slice(0, 300) : DEFAULT_MESSAGE,
    startsAt: iso(toMs(c.startsAt)),
    endsAt: iso(toMs(c.endsAt)),
    estimatedBackAt: iso(toMs(c.estimatedBackAt)),
    scope,
    libraryIds: uniq(c.libraryIds),
    allowUserIds: uniq(c.allowUserIds),
    allowIps: uniq(c.allowIps),
    pauseCrons: !!c.pauseCrons,
    reason: typeof c.reason === 'string' ? c.reason.slice(0, 300) : '',
    updatedAt: iso(toMs(c.updatedAt)),
    updatedBy: c.updatedBy || null,
    updatedByName: typeof c.updatedByName === 'string' ? c.updatedByName.slice(0, 80) : null,
  };
};

/**
 * Where is this config in time?  'off' | 'upcoming' | 'active'
 *  - on: active until endsAt (if one was set), then off by itself
 *  - scheduled: upcoming before startsAt, active inside [startsAt, endsAt), off after
 */
const phase = (cfg, now = Date.now(), env = process.env) => {
  if (forcedOff(env)) return 'off';
  const c = normalize(cfg);
  const t = now instanceof Date ? now.getTime() : now;
  const end = toMs(c.endsAt);
  if (c.mode === 'on') return end !== null && t >= end ? 'off' : 'active';
  if (c.mode === 'scheduled') {
    const start = toMs(c.startsAt);
    if (start === null || end === null) return 'off';
    if (t < start) return 'upcoming';
    return t < end ? 'active' : 'off';
  }
  return 'off';
};

/**
 * Does the active window block this request?
 * ctx: { method, userType, userId, libraryId, ip }   (userType may be unknown for public requests)
 * Super admins and allow-listed accounts/addresses are never blocked.
 */
const blocks = (cfg, ctx = {}, now = Date.now(), env = process.env) => {
  if (phase(cfg, now, env) !== 'active') return false;
  const c = normalize(cfg);
  if (ctx.userType === 'superadmin') return false;
  if (ctx.userId && c.allowUserIds.includes(String(ctx.userId))) return false;
  if (ctx.ip && c.allowIps.includes(String(ctx.ip))) return false;
  if (c.scope === 'readOnly') return !SAFE_METHODS.has(String(ctx.method || 'GET').toUpperCase());
  if (c.scope === 'libraries') return !!ctx.libraryId && c.libraryIds.includes(String(ctx.libraryId));
  return true; // 'all'
};

/** Seconds a client should wait before trying again (Retry-After). */
const retryAfterSeconds = (cfg, now = Date.now()) => {
  const c = normalize(cfg);
  const t = now instanceof Date ? now.getTime() : now;
  const target = toMs(c.estimatedBackAt) ?? toMs(c.endsAt);
  if (target !== null && target > t) return Math.min(86400, Math.max(30, Math.ceil((target - t) / 1000)));
  return 300;
};

/** What the client is told when it is blocked. */
const blockedBody = (cfg, now = Date.now()) => {
  const c = normalize(cfg);
  return {
    success: false,
    code: 503,
    maintenance: true,
    readOnly: c.scope === 'readOnly',
    message: c.scope === 'readOnly' ? `${c.message} (Read-only right now: you can look at your data but not change it.)` : c.message,
    estimatedBackAt: c.estimatedBackAt || c.endsAt || null,
    retryAfter: retryAfterSeconds(c, now),
  };
};

/** Safe-for-anyone view used by /public/maintenance-status and /public/branding. No ids, no internal reason. */
const publicView = (cfg, now = Date.now(), env = process.env) => {
  const c = normalize(cfg);
  const p = phase(c, now, env);
  const forced = forcedOff(env);
  return {
    state: p,
    scope: c.scope,
    readOnly: c.scope === 'readOnly',
    // only 'all'/'readOnly' windows hit everybody; a library-scoped window is announced to those libraries directly
    global: c.scope !== 'libraries',
    message: p === 'off' ? null : c.message,
    startsAt: p === 'off' ? null : c.startsAt,
    endsAt: p === 'off' ? null : c.endsAt,
    estimatedBackAt: p === 'off' ? null : (c.estimatedBackAt || c.endsAt || null),
    forcedOff: forced && (c.mode !== 'off'),
  };
};

/** Should scheduled jobs be skipped right now? */
const cronsPaused = (cfg, now = Date.now(), env = process.env) => {
  const c = normalize(cfg);
  return c.pauseCrons && phase(c, now, env) === 'active';
};

/**
 * Validate what a super admin submitted. Returns { ok:true, value } or { ok:false, error }.
 * action: 'enable' | 'schedule' | 'update'
 */
const validateWindow = (input = {}, action, now = Date.now()) => {
  const t = now instanceof Date ? now.getTime() : now;
  const fail = (error) => ({ ok: false, error });
  const message = String(input.message || '').trim();
  if (message.length < 3) return fail('Write a message for visitors (at least 3 characters).');
  if (message.length > 300) return fail('The message can be at most 300 characters.');
  const scope = SCOPES.includes(input.scope) ? input.scope : 'all';
  const libraryIds = uniq(input.libraryIds);
  if (scope === 'libraries' && !libraryIds.length) return fail('Choose at least one library for a library-only window.');
  if (libraryIds.length > 200) return fail('Choose at most 200 libraries.');
  const allowIps = uniq(input.allowIps);
  if (allowIps.length > 20 || allowIps.some((ip) => !net.isIP(ip))) return fail('Allowed IP addresses must be valid IPv4/IPv6 addresses (at most 20).');
  const allowUserIds = uniq(input.allowUserIds);
  if (allowUserIds.length > 20 || allowUserIds.some((id) => !/^[0-9a-fA-F]{24}$/.test(id))) return fail('Allowed accounts must be valid ids (at most 20).');
  const reason = String(input.reason || '').trim();
  if (!reason) return fail('Write the reason for this window (kept in the history for your team).');

  const start = toMs(input.startsAt);
  const end = toMs(input.endsAt);
  const back = toMs(input.estimatedBackAt);
  if (input.startsAt && start === null) return fail('The start time is not a valid date.');
  if (input.endsAt && end === null) return fail('The end time is not a valid date.');
  if (input.estimatedBackAt && back === null) return fail('The expected back-online time is not a valid date.');

  let mode;
  if (action === 'schedule') {
    mode = 'scheduled';
    if (start === null || end === null) return fail('Choose both a start and an end time.');
    if (start < t - PAST_TOLERANCE_MS) return fail('The start time is in the past.');
    if (start > t + MAX_AHEAD_MS) return fail('You can schedule at most 90 days ahead.');
    if (end <= start) return fail('The end time must be after the start time.');
    if (end - start > MAX_WINDOW_MS) return fail('A window can last at most 72 hours.');
  } else {
    mode = 'on';
    if (end !== null) {
      if (end <= t) return fail('The automatic end time is in the past.');
      if (end - t > MAX_WINDOW_MS) return fail('A window can last at most 72 hours. Leave the end time empty to end it by hand.');
    }
  }
  if (back !== null && back <= t - PAST_TOLERANCE_MS) return fail('The expected back-online time is in the past.');
  if (back !== null && back - t > MAX_AHEAD_MS) return fail('The expected back-online time is too far ahead.');

  return {
    ok: true,
    value: {
      mode,
      message,
      scope,
      libraryIds: scope === 'libraries' ? libraryIds : [],
      allowUserIds,
      allowIps,
      pauseCrons: !!input.pauseCrons,
      reason,
      startsAt: mode === 'scheduled' ? iso(start) : (start !== null ? iso(start) : iso(t)),
      endsAt: iso(end),
      estimatedBackAt: iso(back),
    },
  };
};

module.exports = {
  MODES, SCOPES, MAX_WINDOW_MS, DEFAULT_MESSAGE,
  forcedOff, normalize, phase, blocks, retryAfterSeconds, blockedBody, publicView, cronsPaused, validateWindow,
};
