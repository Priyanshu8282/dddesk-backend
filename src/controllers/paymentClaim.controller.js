const catchAsync = require('../utils/catchAsync');
const svc = require('../services/paymentClaim.service');
const { tenantId } = require('../middlewares/access.middleware');

const lib = (req) => tenantId(req);
const ok = (res, message, data, code = 200) => res.status(code).json({ success: true, message, data });

// ── Student-facing ──────────────────────────────────────────────────────────
exports.getMyPaymentQr = catchAsync(async (req, res) => {
    ok(res, 'Payment QR', await svc.getPaymentQr(req.user._id));
});

exports.submitClaim = catchAsync(async (req, res) => {
    const claim = await svc.submitClaim(req.user._id, req.body);
    ok(res, 'Payment submitted. The library will verify and approve it shortly.', claim, 201);
});

exports.listMyClaims = catchAsync(async (req, res) => {
    ok(res, 'My payment claims', await svc.listMyClaims(req.user._id, req.query));
});

// ── Owner/staff ──────────────────────────────────────────────────────────────
exports.listClaims = catchAsync(async (req, res) => {
    ok(res, 'Payment claims', await svc.listClaims(req, lib(req), req.query));
});

exports.approveClaim = catchAsync(async (req, res) => {
    const claim = await svc.approveClaim(req, lib(req), req.params.id, req.body);
    ok(res, 'Payment approved and recorded', claim);
});

exports.rejectClaim = catchAsync(async (req, res) => {
    const claim = await svc.rejectClaim(req, lib(req), req.params.id, req.body.reason);
    ok(res, 'Payment claim rejected', claim);
});
