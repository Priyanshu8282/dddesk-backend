const humanCheck = require('../services/humanCheck.service');
const securityLog = require('../utils/securityLog');
const { isMobileClient } = require('../utils/clientPlatform');

// Express middlewares for human verification (contract: backend/doc/onboarding-contract.md section 2).

const tokenOf = (req) => (req.body && req.body.humanToken) || req.headers['x-human-token'] || '';

const denyRequired = (res) =>
    res.status(403).json({
        success: false, code: 403, errorCode: 'HUMAN_CHECK_REQUIRED',
        message: 'Please confirm you are human to continue.', humanCheck: humanCheck.publicConfig(),
    });

const run = async (req, res, next, opts = {}) => {
    // Native apps (X-Client-Platform: mobile) use the proof-of-work puzzle whatever web provider is configured.
    // This is a deliberate trade-off (weaker than a captcha); see SECURITY.md. Rate limits and lockouts still apply.
    const mobile = isMobileClient(req);
    const log = (outcome, reason) => {
        securityLog.record(req, {
            type: 'human_check', outcome, reason,
            meta: { provider: mobile ? 'pow-mobile' : humanCheck.provider(), client: mobile ? 'mobile' : 'web', path: (req.originalUrl || '').split('?')[0].slice(0, 80) },
        });
        if (mobile && outcome !== 'success') {
            humanCheck.recordMobileFailure(req.ip).then((abuse) => {
                if (abuse) securityLog.record(req, { type: 'human_check', outcome: 'blocked', reason: 'mobile_pow_abuse', meta: { client: 'mobile', note: 'repeated failed human checks from one address' } });
            }).catch(() => {});
        }
    };
    try {
        const soft = humanCheck.softSignals(req.body);
        if (soft) {
            log('failure', soft);
            return res.status(400).json({ success: false, code: 400, errorCode: 'HUMAN_CHECK_FAILED', message: 'Human verification failed. Please try again.' });
        }
        const token = tokenOf(req);
        if (!token && humanCheck.provider() !== 'off') return denyRequired(res);
        const r = await humanCheck.verifyToken(token, { ip: req.ip, silent: !!opts.silent, mobile });
        if (r.ok) {
            // the token fields are not business data: keep them out of downstream validation/storage
            if (req.body && typeof req.body === 'object') { delete req.body.humanToken; delete req.body.hp_website; delete req.body.fillMs; }
            return next();
        }
        if (r.unavailable) {
            log('failure', `unavailable:${r.reason}`);
            // fail closed in production; elsewhere let developers continue
            if (process.env.NODE_ENV === 'production') {
                return res.status(503).json({ success: false, code: 503, errorCode: 'HUMAN_CHECK_UNAVAILABLE', message: 'Verification is temporarily unavailable. Please try again in a moment.' });
            }
            return next();
        }
        log('failure', r.reason || 'rejected');
        return res.status(400).json({ success: false, code: 400, errorCode: 'HUMAN_CHECK_FAILED', message: 'Human verification failed. Please try again.' });
    } catch (e) { return next(e); }
};

/** Always required. */
const requireHuman = (req, res, next) => run(req, res, next);

/** Always required, but for forms without a visible checkbox: the automatic proof-of-work token is accepted whatever the provider. */
const requireHumanSilent = (req, res, next) => run(req, res, next, { silent: true });

/** Required only for native apps (send-otp): the web sign-in OTP request keeps its existing rate limits only. */
const requireHumanMobile = (req, res, next) => (isMobileClient(req) ? run(req, res, next) : next());

/** Native apps may send a puzzle token on verify-otp; it is checked when present but not required (the OTP and the rate limits protect it). */
const acceptHumanMobile = async (req, res, next) => {
    if (isMobileClient(req) && ((req.body && req.body.humanToken) || req.headers['x-human-token'])) return run(req, res, next);
    if (req.body && typeof req.body === 'object') { delete req.body.humanToken; delete req.body.hp_website; delete req.body.fillMs; }
    return next();
};

/** Required only after N failed attempts for the typed identifier or the caller IP (login). */
const requireHumanAfterFailures = async (req, res, next) => {
    try {
        const b = req.body || {};
        const id = b.identifier || b.email || b.mobile || '';
        // a failing counter lookup must not block sign-in (per-account lockout and rate limits still apply)
        const needs = humanCheck.provider() !== 'off' && await humanCheck.loginNeedsChallenge(id, req.ip).catch(() => false);
        if (!needs) {
            if (req.body && typeof req.body === 'object') { delete req.body.humanToken; delete req.body.hp_website; delete req.body.fillMs; }
            return next();
        }
        return run(req, res, next);
    } catch (e) { return next(e); }
};

/** Legacy multipart register: only when HUMAN_CHECK_ENFORCE_LEGACY=true */
const requireHumanLegacy = (req, res, next) =>
    (String(process.env.HUMAN_CHECK_ENFORCE_LEGACY || '').toLowerCase() === 'true' ? run(req, res, next) : next());

module.exports = { requireHuman, requireHumanSilent, requireHumanAfterFailures, requireHumanLegacy, requireHumanMobile, acceptHumanMobile };
