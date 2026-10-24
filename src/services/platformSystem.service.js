/**
 * System side of Platform Settings: server health, the MongoDB connection, and a small, safe editor for
 * the server's .env file.
 *
 * SAFETY RULES
 *  - Secrets are never returned. The database URL is shown masked (user:****@host/db).
 *  - Only a fixed list of keys can be edited; each edit needs the super admin's CURRENT PASSWORD again.
 *  - A new database URL is test-connected first and is saved only if the connection works.
 *  - The old .env is backed up before every change; the file is replaced atomically.
 *  - Changes take effect after the server restarts. A read-only host (e.g. Vercel) refuses with a clear message.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Admin = require('../models/admin.model');
const GlobalSetting = require('../models/setting.model');
const providerConfig = require('./notificationProviderConfig.service');
const { RETENTION_DAYS } = require('../models/securityEvent.model');
const pkg = require('../../package.json');
const dns = require('dns').promises;
const net = require('net');

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const ENV_PATH = process.env.ENV_FILE_PATH || path.join(__dirname, '..', '..', '.env'); // override is for tests
const SUBSCRIPTION_CRON_KEY = 'cron:subscription-lifecycle:lastRun';

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------
// "mongodb://admin:pw@h1:27017,h2:27017/lms?x=1" -> "mongodb://ad****:****@h1 (+1 more)/lms". Handles multi-host (replica set) URLs.
const maskMongoUrl = (url) => {
  const raw = String(url || '').trim();
  const m = /^(mongodb(?:\+srv)?):\/\/(.*)$/i.exec(raw);
  if (!m) return raw ? 'mongodb://****' : null;
  const rest = m[2].split('?')[0];                    // drop options (may contain secrets)
  const at = rest.lastIndexOf('@');
  const creds = at >= 0 ? rest.slice(0, at) : '';
  const hostPath = at >= 0 ? rest.slice(at + 1) : rest;
  const slash = hostPath.indexOf('/');
  const hostsRaw = slash >= 0 ? hostPath.slice(0, slash) : hostPath;
  const dbName = slash >= 0 ? hostPath.slice(slash) : '';
  const hosts = hostsRaw.split(',').map((h) => h.replace(/:\d+$/, '')).filter(Boolean);
  const user = creds ? creds.split(':')[0] : '';
  let userShown = '';
  try { userShown = user ? decodeURIComponent(user).slice(0, 2) + '****' : ''; } catch (_) { userShown = '****'; }
  if (!hosts.length) return 'mongodb://****';
  return `${m[1].toLowerCase()}://${creds ? `${userShown}:****@` : ''}${hosts[0]}${hosts.length > 1 ? ` (+${hosts.length - 1} more)` : ''}${dbName}`;
};
const sanitizeError = (e) => String((e && e.message) || e).replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://****').slice(0, 220);

// ---------------------------------------------------------------------------
// Password re-check for sensitive changes
// ---------------------------------------------------------------------------
exports.verifyPassword = async (req, password) => {
  if (req.impersonatedBy) throw err('Not allowed during a support session', 403);
  const me = await Admin.findById(req.user._id).select('+password');
  if (!me || !password || !(await bcrypt.compare(String(password), me.password))) throw err('Your password is incorrect', 400);
};

// ---------------------------------------------------------------------------
// .env editing
// ---------------------------------------------------------------------------
const EDITABLE = {
  MONGODB_URL: { label: 'MongoDB connection URL', secret: true, check: (v) => /^mongodb(\+srv)?:\/\/.+/i.test(v) || 'Must start with mongodb:// or mongodb+srv://' },
  ALLOWED_ORIGINS: { label: 'Allowed website addresses (CORS), comma separated', check: (v) => v.split(',').every((o) => { try { return /^https?:$/.test(new URL(o.trim()).protocol); } catch (_) { return false; } }) || 'Each item must be a full address like https://app.example.com' },
  OTP_IN_RESPONSE: { label: 'Show OTP in the API response (development only)', check: (v) => ['true', 'false'].includes(v) || 'Must be true or false' },
  SECURITY_LOG_RETENTION_DAYS: { label: 'Days to keep security events', check: (v) => (/^\d+$/.test(v) && Number(v) >= 7 && Number(v) <= 3650) || 'Enter a number of days between 7 and 3650' },
};
if (process.env.NODE_ENV === 'production') delete EDITABLE.OTP_IN_RESPONSE; // never switch the OTP leak on from a web form
exports.EDITABLE_KEYS = Object.keys(EDITABLE);

const envWritable = () => {
  try { fs.accessSync(ENV_PATH, fs.constants.R_OK | fs.constants.W_OK); fs.accessSync(path.dirname(ENV_PATH), fs.constants.W_OK); return true; } catch (_) { return false; }
};

const readEnvRaw = () => fs.readFileSync(ENV_PATH, 'utf8');
const envLine = new RegExp('^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=(.*)$');

exports.readEnvValue = (key) => {
  try {
    for (const line of readEnvRaw().split(/\r?\n/)) { const m = envLine.exec(line); if (m && m[1] === key) return m[2].trim().replace(/^['"]|['"]$/g, ''); }
  } catch (_) { /* no file */ }
  return process.env[key] || '';
};

const backupEnv = () => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = `${ENV_PATH}.bak-${stamp}`;
  fs.copyFileSync(ENV_PATH, dest);
  // keep only the 5 newest backups
  const dir = path.dirname(ENV_PATH); const base = path.basename(ENV_PATH) + '.bak-';
  fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort().reverse().slice(5).forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ } });
  return path.basename(dest);
};

const writeEnvKey = (key, value) => {
  if (/[\r\n]/.test(value)) throw err('Value cannot contain line breaks');
  const raw = readEnvRaw();
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  let done = false;
  const out = lines.map((line) => {
    const m = envLine.exec(line);
    if (!done && m && m[1] === key && !/^\s*#/.test(line)) { done = true; return `${key}=${value}`; }
    return line;
  });
  if (!done) { if (out.length && out[out.length - 1] === '') out.splice(out.length - 1, 0, `${key}=${value}`); else out.push(`${key}=${value}`); }
  const backup = backupEnv();
  const tmp = `${ENV_PATH}.tmp`;
  fs.writeFileSync(tmp, out.join(eol), 'utf8');
  fs.renameSync(tmp, ENV_PATH);
  return backup;
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
exports.databaseStatus = async () => {
  const conn = mongoose.connection;
  let latencyMs = null; let ok = false;
  try { const t = Date.now(); await conn.db.admin().ping(); latencyMs = Date.now() - t; ok = true; } catch (_) { /* down */ }
  const url = exports.readEnvValue('MONGODB_URL') || process.env.MONGODB_URL || process.env.MONGODB_URI || '';
  return {
    connected: ok, readyState: conn.readyState, latencyMs,
    databaseName: conn.name || null, host: conn.host || null,
    urlMasked: maskMongoUrl(url),
    canEditEnvironment: envWritable(),
    restartNeeded: !!url && !!process.env.MONGODB_URL && url !== process.env.MONGODB_URL,
  };
};

// ---------------------------------------------------------------------------
// SSRF guard for "test a connection string": the server must not be usable to probe its own private network
// (loopback, RFC1918, link-local / cloud metadata 169.254.169.254, CGNAT, unique-local IPv6).
// Enforced in production; ALLOW_PRIVATE_DB_HOSTS=true opts out (e.g. a database inside the same private network).
// ---------------------------------------------------------------------------
const isPrivateIp = (ip) => {
  let a = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254)
      || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 192 && q === 0) || p >= 224;
  }
  if (net.isIPv6(a)) return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff');
  return true; // unparsable: treat as unsafe
};

/** Host names inside a mongodb:// or mongodb+srv:// URL (credentials, ports and options removed). */
const mongoHosts = (url) => {
  const m = /^(mongodb(?:\+srv)?):\/\/([^/?]*)/i.exec(String(url).trim());
  if (!m) return { srv: false, hosts: [] };
  const authority = m[2];
  const at = authority.lastIndexOf('@');
  const hostsRaw = at >= 0 ? authority.slice(at + 1) : authority;
  const hosts = hostsRaw.split(',').map((h) => h.trim()).filter(Boolean).map((h) => {
    if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
    return h.replace(/:\d+$/, '');
  });
  return { srv: /srv/i.test(m[1]), hosts };
};

const assertSafeDatabaseTarget = async (url, { enforce = process.env.NODE_ENV === 'production' && process.env.ALLOW_PRIVATE_DB_HOSTS !== 'true', resolve = dns } = {}) => {
  if (!enforce) return;
  const { srv, hosts } = mongoHosts(url);
  if (!hosts.length || hosts.length > 10) throw err('Enter a valid MongoDB connection URL');
  const names = [];
  for (const h of hosts) {
    if (net.isIP(h)) { names.push(h); continue; }
    if (srv) {
      try { (await resolve.resolveSrv('_mongodb._tcp.' + h)).forEach((r) => names.push(r.name)); } catch (_) { /* unresolvable: the connection fails anyway */ }
    } else names.push(h);
  }
  for (const n of names) {
    if (net.isIP(n)) { if (isPrivateIp(n)) throw err('That address points to a private or internal network and cannot be tested from here', 400); continue; }
    if (/^localhost$|[.]local$|[.]internal$/i.test(n)) throw err('That address points to a private or internal network and cannot be tested from here', 400);
    let addrs = [];
    try { addrs = await resolve.lookup(n, { all: true }); } catch (_) { continue; }
    if (addrs.some((x) => isPrivateIp(x.address))) throw err('That address points to a private or internal network and cannot be tested from here', 400);
  }
};
exports._isPrivateIp = isPrivateIp;
exports._mongoHosts = mongoHosts;
exports.assertSafeDatabaseTarget = assertSafeDatabaseTarget;

/** Try a connection string for real, then drop it. Never touches the live connection or any data. */
exports.testDatabase = async (url) => {
  if (!EDITABLE.MONGODB_URL.check(url) || EDITABLE.MONGODB_URL.check(url) !== true) throw err('Enter a valid MongoDB connection URL (mongodb:// or mongodb+srv://)');
  await assertSafeDatabaseTarget(url);
  const started = Date.now();
  let c;
  try {
    const opts = { serverSelectionTimeoutMS: 8000, maxPoolSize: 1 };
    if (process.env.DB_IP_FAMILY) opts.family = Number(process.env.DB_IP_FAMILY);
    c = await mongoose.createConnection(url, opts).asPromise();
    await c.db.admin().ping();
    const latencyMs = Date.now() - started;
    const names = (await c.db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name);
    const warnings = [];
    if (!names.includes('admins')) warnings.push('This database has no "admins" collection. It looks empty or is not the DDdesk database.');
    else {
      const sa = await c.db.collection('admins').countDocuments({ userType: 'superadmin' });
      if (!sa) warnings.push('No super admin account exists in this database. You would not be able to sign in.');
    }
    return { ok: true, latencyMs, databaseName: c.name, collections: names.length, isCurrent: c.name === mongoose.connection.name && c.host === mongoose.connection.host, warnings, urlMasked: maskMongoUrl(url) };
  } catch (e) {
    return { ok: false, error: sanitizeError(e), urlMasked: maskMongoUrl(url) };
  } finally {
    if (c) c.close().catch(() => {});
  }
};

// ---------------------------------------------------------------------------
// Saving environment values
// ---------------------------------------------------------------------------
exports.environmentInfo = () => ({
  canEdit: envWritable(),
  keys: Object.entries(EDITABLE).map(([key, d]) => ({
    key, label: d.label, secret: !!d.secret,
    value: d.secret ? null : exports.readEnvValue(key) || null,
    masked: d.secret ? maskMongoUrl(exports.readEnvValue(key)) : null,
  })),
});

exports.saveEnvironment = async (req, { key, value, password }) => {
  const def = EDITABLE[key];
  if (!def) throw err('That setting cannot be changed from here');
  const v = String(value == null ? '' : value).trim();
  if (!v) throw err('A value is required');
  const ok = def.check(v);
  if (ok !== true) throw err(ok);
  if (!envWritable()) throw err('This server cannot edit its own settings file (common on hosted platforms). Change it in your hosting dashboard and restart.', 409);
  await exports.verifyPassword(req, password);

  let test = null;
  if (key === 'MONGODB_URL') {
    test = await exports.testDatabase(v);
    if (!test.ok) throw err(`The new database could not be reached, so nothing was changed. ${test.error}`);
  }
  const backup = writeEnvKey(key, v);
  return { key, saved: true, restartRequired: true, backup, ...(test ? { test } : {}), valueMasked: def.secret ? maskMongoUrl(v) : v };
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
const yes = (c) => !!c;
exports.health = async () => {
  await providerConfig.ensureFresh().catch(() => {});
  const mail = providerConfig.effectiveConfig().email;
  const [db, cron] = await Promise.all([
    exports.databaseStatus(),
    GlobalSetting.findOne({ key: SUBSCRIPTION_CRON_KEY }).lean().then((d) => d && d.value).catch(() => null),
  ]);
  const prod = process.env.NODE_ENV === 'production';
  const mem = process.memoryUsage();
  const checks = [
    { key: 'database', label: 'Database', ok: db.connected, detail: db.connected ? `Connected, ${db.latencyMs} ms` : 'Not connected' },
    { key: 'razorpay', label: 'Online payments (Razorpay keys)', ok: yes(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET), detail: process.env.RAZORPAY_KEY_ID ? 'Keys set' : 'Not set: payments will not work' },
    { key: 'razorpayWebhook', label: 'Payment webhook secret', ok: yes(process.env.RAZORPAY_WEBHOOK_SECRET), detail: process.env.RAZORPAY_WEBHOOK_SECRET ? 'Set' : 'Not set: payment confirmations by webhook are rejected' },
    { key: 'email', label: 'E-mail sending', ok: !!mail.host, detail: mail.host ? `${mail.source === 'settings' ? 'Settings' : 'Environment'}: ${mail.host}` : 'Not configured: e-mails are not sent' },
    { key: 'sms', label: 'SMS sending', ok: yes(process.env.SMS_API_URL || providerConfig.effectiveConfig().sms.enabled), detail: process.env.SMS_API_URL || providerConfig.effectiveConfig().sms.enabled ? 'Configured' : 'Not configured: OTPs by SMS are not sent' },
    { key: 'ai', label: 'AI assistant (Gemini key)', ok: yes(process.env.GEMINI_API_KEY), detail: process.env.GEMINI_API_KEY ? 'Key set' : 'Not set: uses the basic rule-based assistant' },
    { key: 'cron', label: 'Scheduled jobs secret (CRON_SECRET)', ok: yes(process.env.CRON_SECRET), detail: process.env.CRON_SECRET ? 'Set' : 'Not set: needed only on serverless hosting such as Vercel' },
    { key: 'jwt', label: 'Login token secret', ok: (process.env.JWT_SECRET || '').length >= 32, detail: (process.env.JWT_SECRET || '').length >= 32 ? 'Strong' : 'Too short: use 32 or more random characters' },
    { key: 'otpExposure', label: 'OTP hidden from the API', ok: prod ? process.env.OTP_IN_RESPONSE !== 'true' : false, detail: prod ? (process.env.OTP_IN_RESPONSE === 'true' ? 'OTP is exposed in the API response: turn off' : 'Hidden') : 'Development mode shows the OTP in the response. Fine for testing, never for live use' },
  ];
  return {
    server: {
      environment: process.env.NODE_ENV || 'development', version: pkg.version, node: process.version, platform: `${os.type()} ${os.release()}`,
      uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(mem.rss / 1048576), startedAt: new Date(Date.now() - process.uptime() * 1000),
    },
    database: db,
    checks,
    retention: { securityEventDays: RETENTION_DAYS },
    scheduledJobs: { lastSubscriptionRun: cron || null },
  };
};

exports.maskMongoUrl = maskMongoUrl;
