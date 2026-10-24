/**
 * Alerts to the platform owners (super admins): an in-app notice for every active super admin, plus an e-mail
 * to the addresses configured in Platform Settings. Which events fire is controlled by the settings, so
 * switching an event off really silences it. Never throws and never delays the caller.
 */
const Admin = require('../models/admin.model');
const Notification = require('../models/notification.model');
const settings = require('./platformSettings.service');

const EVENTS = {
  newRegistration: { title: 'New library registration', type: 'platform_alert' },
  contactMessage: { title: 'New website contact message', type: 'platform_alert' },
  paymentFailed: { title: 'Subscription payment failed', type: 'platform_alert' },
  subscriptionSuspended: { title: 'Library suspended for non-payment', type: 'platform_alert' },
  securityAlert: { title: 'Security alert', type: 'security_alert' },
};

// do not repeat the same alert (e.g. the same attacking address) more than once an hour
const recent = new Map();
const SUPPRESS_MS = 60 * 60 * 1000;
const suppressed = (key) => {
  if (!key) return false;
  const now = Date.now();
  if (recent.size > 2000) { for (const [k, t] of recent) if (now - t > SUPPRESS_MS) recent.delete(k); }
  const t = recent.get(key);
  if (t && now - t < SUPPRESS_MS) return true;
  recent.set(key, now);
  return false;
};

exports.EVENTS = Object.keys(EVENTS);

/**
 * notify('securityAlert', { message: '...', dedupeKey: 'ip:1.2.3.4', libraryId? })
 */
exports.notify = (event, { message, dedupeKey = null, libraryId = null, data = {} } = {}) => {
  (async () => {
    try {
      const def = EVENTS[event];
      if (!def) return;
      await settings.ensureFresh();
      const cfg = settings.alertConfig();
      if (!cfg.events || cfg.events[event] === false) return;
      if (suppressed(dedupeKey && `${event}:${dedupeKey}`)) return;

      const admins = await Admin.find({ userType: 'superadmin', status: true }).select('_id email').lean();
      if (admins.length) {
        await Notification.insertMany(admins.map((a) => ({
          recipientId: a._id, recipientType: 'Admin', ...(libraryId ? { libraryId } : {}),
          type: def.type, event, title: def.title, message,
          data: Object.fromEntries(Object.entries({ event, ...data }).map(([k, v]) => [k, String(v)])),
          deliveries: [{ channel: 'inapp', status: 'sent' }],
        })));
      }
      const to = [...new Set((cfg.superAdminEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
      if (to.length) {
        const { sendPlatformEmail } = require('./notification.service');
        await Promise.all(to.map((addr) => sendPlatformEmail(addr, `[${settings.current().general.platformName}] ${def.title}`, message)));
      }
    } catch (e) {
      console.error(`[platform-alert] ${event} failed:`, e.message);
    }
  })();
};
