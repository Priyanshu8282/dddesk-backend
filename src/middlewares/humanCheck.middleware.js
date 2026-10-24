const humanCheck = require('../services/humanCheck.service');
const securityLog = require('../utils/securityLog');

// Express middlewares for human verification (contract: backend/doc/onboarding-contract.md section 2).

const tokenOf = (req) => (req.body && req.body.humanToken) || req.headers['x-human-token'] || '';

const denyRequired = (res) =>
    res.status(403).json({
        success: false, code: 403, errorCode: 'HUMAN_CHECK_REQUIRED',
        message: 'Please confirm you are human to continue.', humanCheck: humanCheck.publicConfig(),
    });

const run = async (req, res, next) => {
    const log = (outcome, reason) => securityLog.record(req, {
        type: 'human_check', outcome, reason,
        meta: { provider: humanCheck.provider(), path: (req.originalUrl || '').split('?')[0].slice(0, 80) },
    });
    try {
        const soft = humanCheck.softSignals(req.body);
        if (soft) {
            log('failure', soft);
            return res.status(400).json({ success: false, code: 400, errorCode: 'HUMAN_CHECK_FAILED', message: 'Human verification failed. Please try again.' });
        }
        const token = tokenOf(req);
        if (!token && humanCheck.provider() !== 'off') return denyRequired(res);
        const r = await humanCheck.verifyToken(token, { ip: req.ip });
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
const requireHuman = run;

/** Required only after N failed attempts for the typed identifier or the caller IP (login). */
const requireHumanAfterFailures = async (req, res, next) => {
    try {
        const b = req.body || {};
        const id = b.identifier || b.email || b.mobile || '';
        if (humanCheck.provider() === 'off' || !(await humanCheck.loginNeedsChallenge(id, req.ip))) {
            if (req.body && typeof req.body === 'object') { delete req.body.humanToken; delete req.body.hp_website; delete req.body.fillMs; }
            return next();
        }
        return run(req, res, next);
    } catch (e) { return next(e); }
};

/** Legacy multipart register: only when HUMAN_CHECK_ENFORCE_LEGACY=true */
const requireHumanLegacy = (req, res, next) =>
    (String(process.env.HUMAN_CHECK_ENFORCE_LEGACY || '').toLowerCase() === 'true' ? run(req, res, next) : next());

module.exports = { requireHuman, requireHumanAfterFailures, requireHumanLegacy };
