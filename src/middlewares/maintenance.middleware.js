/**
 * Central maintenance gate, mounted on /v1 before any router (see app.js).
 *
 * It decides for PUBLIC routes (sign-up, OTP, public website, ...). Routes under /private need to know who is
 * calling (super admins always keep working), so those are decided in auth.middleware.js with the same rules,
 * and sign-in decides in auth.controller.js once the account type is known.
 *
 * ALWAYS allowed, in every mode:
 *   - health check, branding, maintenance-status (the apps need them to show the right screen)
 *   - sign-in / refresh / logout / password reset (the account type is checked inside; super admins must get in)
 *   - the Razorpay webhook (money already taken must still be recorded)
 *   - cron endpoints (they have their own "pause jobs" switch) and super admin routes (they require a super admin)
 *   - harmless reference data (locations)
 */
const maintenance = require('../services/maintenance.service');

const ALWAYS_OPEN = [
  /^\/public\/health(\/|$)/,
  /^\/public\/branding(\/|$)/,
  /^\/public\/maintenance-status(\/|$)/,
  /^\/public\/razorpay\/webhook(\/|$)/,
  /^\/public\/locations(\/|$)/,
  /^\/public\/(login|refresh|logout|send-otp|verify-otp|forgot-password|verify-reset-otp|reset-password)\/?$/,
  /^\/cron(\/|$)/,
  /^\/private\/(super|superadmin)(\/|$)/,
  /^\/private\/(me|logout-all)\/?$/,
];

const isPrivate = (path) => /^\/private(\/|$)/.test(path);

const maintenanceGate = async (req, res, next) => {
  try {
    // `/v1/public/x` and the fallback `/v1/x` mount both reach here with the path relative to /v1
    const path = req.path.replace(/\/{2,}/g, '/');
    if (ALWAYS_OPEN.some((re) => re.test(path))) return next();
    // signed-in routes: the user is only known after authentication, which applies the same rules
    if (isPrivate(path)) return next();
    const body = await maintenance.check({ method: req.method, ip: req.ip });
    if (body) return maintenance.sendBlocked(res, body);
    return next();
  } catch (e) {
    // a failure of the gate itself must never take the platform down
    console.error('[maintenance] gate error:', e.message);
    return next();
  }
};

module.exports = maintenanceGate;
module.exports.ALWAYS_OPEN = ALWAYS_OPEN;
