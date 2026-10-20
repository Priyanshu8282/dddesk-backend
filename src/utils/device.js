/**
 * Who/what is on the other end of a request: a clean IP address and the browser/OS/device behind a User-Agent.
 * No dependencies and no network calls. What it CANNOT know is stated in the comments (e.g. real location).
 */

// ---------------------------------------------------------------------------
// IP address
// ---------------------------------------------------------------------------
const os = require('os');

// This machine's own network address (e.g. 192.168.1.20). A request from the same computer arrives as 127.0.0.1,
// which says nothing useful, so it is shown as the machine's real address instead.
let systemIpCache;
const systemIp = () => {
  if (systemIpCache !== undefined) return systemIpCache;
  systemIpCache = null;
  const all = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
  const pick = all.find((i) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) || all[0];
  if (pick) systemIpCache = pick.address;
  return systemIpCache;
};

const PRIVATE_V4 = [
  /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[0-1])\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, // 100.64/10 carrier-grade NAT
];

/**
 * normalizeIp("::ffff:103.21.4.9") -> { ip: "103.21.4.9", version: 4, kind: "public" }
 * kind: localhost | private (home/office/VPN network) | public | unknown
 * Behind a proxy Express already resolves the client address (trust proxy); an X-Forwarded-For list keeps only its first entry.
 */
const normalizeIp = (raw) => {
  let ip = String(raw == null ? '' : raw).split(',')[0].trim();
  if (!ip || ip === 'unknown') return { ip: 'unknown', version: null, kind: 'unknown' };
  ip = ip.replace(/^::ffff:/i, '');                  // IPv4 written as IPv6
  if (/^\[.*\](:\d+)?$/.test(ip)) ip = ip.replace(/^\[|\](:\d+)?$/g, '');
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, '');
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
  const version = v4 ? 4 : ip.includes(':') ? 6 : null;
  if (!version) return { ip, version: null, kind: 'unknown' };
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1' || (v4 && /^127\./.test(ip))) {
    const own = systemIp();
    return own ? { ip: own, version: 4, kind: 'localhost', loopback: ip } : { ip, version, kind: 'localhost' };
  }
  if (v4 && PRIVATE_V4.some((r) => r.test(ip))) return { ip, version, kind: 'private' };
  if (!v4 && /^(fc|fd|fe80)/i.test(ip)) return { ip, version, kind: 'private' };
  return { ip, version, kind: 'public' };
};

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------
const BOT = /(bot|crawler|spider|curl\/|wget\/|postman|insomnia|python-requests|node-fetch|axios|okhttp|java\/|go-http-client|httpclient|libwww)/i;

const firstMatch = (ua, rules) => {
  for (const [name, re, fmt] of rules) {
    const m = re.exec(ua);
    if (m) return { name, version: fmt ? fmt(m) : m[1] };
  }
  return null;
};
const major = (v) => (v ? String(v).split(/[._]/)[0] : null);

// order matters: Edge/Opera/Samsung pretend to be Chrome, Chrome pretends to be Safari
const BROWSERS = [
  ['Edge', /\bEdg(?:e|A|iOS)?\/([\d.]+)/, (m) => major(m[1])],
  ['Opera', /\b(?:OPR|Opera)\/([\d.]+)/, (m) => major(m[1])],
  ['Samsung Internet', /\bSamsungBrowser\/([\d.]+)/, (m) => major(m[1])],
  ['Firefox', /\b(?:Firefox|FxiOS)\/([\d.]+)/, (m) => major(m[1])],
  ['Chrome', /\b(?:Chrome|CriOS)\/([\d.]+)/, (m) => major(m[1])],
  ['Safari', /\bVersion\/([\d.]+).*Safari\//, (m) => major(m[1])],
  ['Internet Explorer', /\b(?:MSIE |Trident\/.*rv:)([\d.]+)/, (m) => major(m[1])],
];

const parseOs = (ua) => {
  let m;
  if ((m = /Windows NT ([\d.]+)/.exec(ua))) {
    // Windows 11 still reports NT 10.0, so the two cannot be told apart from the User-Agent alone
    const map = { '10.0': 'Windows 10/11', '6.3': 'Windows 8.1', '6.2': 'Windows 8', '6.1': 'Windows 7', '6.0': 'Windows Vista', '5.1': 'Windows XP' };
    return { os: map[m[1]] || 'Windows', osVersion: null };
  }
  if ((m = /Android ([\d.]+)/.exec(ua))) return { os: 'Android', osVersion: major(m[1]) };
  if (/iPhone|iPad|iPod/.test(ua)) {
    m = /OS ([\d_]+)/.exec(ua);
    return { os: /iPad/.test(ua) ? 'iPadOS' : 'iOS', osVersion: m ? major(m[1]) : null };
  }
  if ((m = /Mac OS X ([\d_.]+)/.exec(ua))) return { os: 'macOS', osVersion: m[1].replace(/_/g, '.').split('.').slice(0, 2).join('.') };
  if (/CrOS/.test(ua)) return { os: 'ChromeOS', osVersion: null };
  if (/Ubuntu/i.test(ua)) return { os: 'Ubuntu Linux', osVersion: null };
  if (/Linux|X11/.test(ua)) return { os: 'Linux', osVersion: null };
  return { os: null, osVersion: null };
};

const parseDeviceType = (ua, os) => {
  if (BOT.test(ua)) return 'bot';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return 'mobile';
  if (os) return 'desktop';
  return 'unknown';
};

// "Pixel 7", "SM-S918B", "iPhone"... only when the User-Agent actually says so
const parseModel = (ua) => {
  let m = /;\s*([^;()]+?)\s+Build\//.exec(ua);          // Android: "; Pixel 7 Build/"
  if (m && !/^(Linux|U|wv)$/.test(m[1])) return m[1];
  m = /Android [\d.]+;\s*([^;)]+)\)/.exec(ua);           // newer Chrome: "Android 10; K)" (model hidden)
  if (m && m[1] && m[1].trim() !== 'K') return m[1].trim();
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  return null;
};

/**
 * parseUserAgent(ua) -> { browser, browserVersion, os, osVersion, deviceType, model, summary }
 * summary example: "Chrome 120 on Windows 10/11 (Desktop)". Any part can be null when the User-Agent does not say.
 */
const parseUserAgent = (raw) => {
  const ua = String(raw || '').slice(0, 400);
  if (!ua) return { browser: null, browserVersion: null, os: null, osVersion: null, deviceType: 'unknown', model: null, summary: null };
  const bot = BOT.test(ua);
  const b = firstMatch(ua, BROWSERS);
  const { os, osVersion } = parseOs(ua);
  const deviceType = parseDeviceType(ua, os);
  const browser = b ? b.name : bot ? ((/^([A-Za-z-]+)\//.exec(ua) || [])[1] || 'Automated client') : null;
  const model = parseModel(ua);
  const typeLabel = { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', bot: 'Automated tool', unknown: null }[deviceType];
  const summary = [
    browser ? `${browser}${b && b.version ? ' ' + b.version : ''}` : null,
    os ? `on ${os}${osVersion ? ' ' + osVersion : ''}` : null,
    typeLabel ? `(${model ? model + ', ' : ''}${typeLabel})` : null,
  ].filter(Boolean).join(' ') || null;
  return { browser, browserVersion: b ? b.version : null, os, osVersion, deviceType, model, summary };
};

/** What to store alongside an event: clean IP + parsed device + the (trimmed) raw User-Agent */
const describeRequest = (req) => {
  const headers = (req && req.headers) || {};
  const ua = String(headers['user-agent'] || '').slice(0, 300) || null;
  const ipInfo = normalizeIp((req && (req.ip || headers['x-forwarded-for'])) || 'unknown');
  return { ip: ipInfo.ip, ipKind: ipInfo.kind, userAgent: ua, device: parseUserAgent(ua) };
};

module.exports = { systemIp, normalizeIp, parseUserAgent, describeRequest };
