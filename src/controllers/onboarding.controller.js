const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const Admin = require('../models/admin.model');
const svc = require('../services/onboarding.service');
const humanCheck = require('../services/humanCheck.service');
const { isMobileClient } = require('../utils/clientPlatform');
const authSvc = require('../services/auth.service');
const sessionService = require('../services/session.service');
const securityLog = require('../utils/securityLog');
const platformSettings = require('../services/platformSettings.service');

const tokenOf = (req) => req.headers['x-registration-token'] || (req.body && req.body.registrationToken) || '';

// ---- public ----
exports.plans = catchAsync(async (req, res) => {
    const plans = await svc.listPublicPlans();
    res.set('Cache-Control', 'public, max-age=30');
    res.status(200).json({
        success: true,
        data: { plans, registrationOpen: platformSettings.registrationOpen(), defaultTrialDays: platformSettings.defaultTrialDays() },
    });
});

exports.humanConfig = (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: humanCheck.publicConfig() });
};

exports.humanChallenge = (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: humanCheck.issueChallenge(Date.now(), { mobile: isMobileClient(req) }) });
};

exports.humanStatus = catchAsync(async (req, res) => {
    const required = humanCheck.provider() !== 'off' && await humanCheck.loginNeedsChallenge(req.query.identifier || '', req.ip);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: { required } });
});

exports.contact = catchAsync(async (req, res) => {
    await svc.submitContact(req.body, req.ip);
    res.status(201).json({ success: true, message: 'Thank you. We have your message and will reply soon.' });
});

exports.getDraft = catchAsync(async (req, res) => {
    const data = await svc.getOrCreateDraft(tokenOf(req));
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data });
});

exports.patchDraft = catchAsync(async (req, res) => {
    const data = await svc.patchDraft(tokenOf(req), req.body, req.ip);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, message: 'Saved', data });
});

// Re-load the freshly created owner exactly like login does, then start a normal session (HttpOnly refresh cookie + access token)
const adminPopulate = [{ path: 'roleId', populate: { path: 'permissionIds' } }, { path: 'libraryId' }];

exports.complete = async (req, res, next) => {
    try {
        const issueSession = async (adminId) => {
            const admin = await Admin.findById(adminId).populate(adminPopulate);
            if (!admin) return null;
            const verified = { token: authSvc.buildToken(admin, 'ADMIN'), userData: authSvc.buildUserData(admin, 'ADMIN'), role: 'admin' };
            const started = await sessionService.startLoginSession(req, res, verified);
            await Admin.updateOne({ _id: admin._id }, { $set: { lastLogin: new Date() } });
            return started;
        };
        const result = await svc.completeRegistration({ token: tokenOf(req), body: req.body, ip: req.ip, issueSession });
        securityLog.record(req, { type: 'register_complete', outcome: 'success', libraryId: result.library.id, meta: { status: result.status } });
        res.set('Cache-Control', 'no-store');
        return res.status(201).json({
            success: true,
            message: result.status === 'active' ? 'Your library is ready.' : 'Your library has been submitted and is awaiting approval.',
            data: result,
        });
    } catch (err) {
        securityLog.record(req, { type: 'register_complete', outcome: 'failure', reason: err.errorCode || `http_${err.status || 500}` });
        return next(err);
    }
};

// ---- private ----
exports.updateTour = catchAsync(async (req, res) => {
    if (req.impersonatedBy) throw new ApiError(403, 'Not allowed while impersonating');
    if (req.userType === 'student') throw new ApiError(403, 'Not available');
    const tour = await svc.updateTour(req.user._id, req.body);
    res.status(200).json({ success: true, data: { tour } });
});

exports.checklist = catchAsync(async (req, res) => {
    const data = await svc.checklist(req);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data });
});
