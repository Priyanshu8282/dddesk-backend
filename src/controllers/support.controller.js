const catchAsync = require('../utils/catchAsync');
const svc = require('../services/support.service');

// ---- library (owner / staff with permission) ----
exports.create = catchAsync(async (req, res) => {
    const data = await svc.createTicket(req);
    res.status(201).json({ success: true, message: 'Support ticket created', data });
});
exports.listOwn = catchAsync(async (req, res) => {
    const r = await svc.listOwn(req.libraryId, req.query);
    res.status(200).json({ success: true, message: 'Support tickets retrieved successfully', ...r });
});
exports.getOwn = catchAsync(async (req, res) => {
    const data = await svc.getOwn(req.params.id, req.libraryId);
    res.status(200).json({ success: true, message: 'Support ticket retrieved successfully', data });
});
exports.replyOwn = catchAsync(async (req, res) => {
    const data = await svc.replyOwn(req);
    res.status(200).json({ success: true, message: 'Reply added', data });
});

// ---- super admin ----
exports.listAll = catchAsync(async (req, res) => {
    const r = await svc.listAll(req.query);
    res.status(200).json({ success: true, message: 'Support tickets retrieved successfully', ...r });
});
exports.getAny = catchAsync(async (req, res) => {
    const data = await svc.getAny(req.params.id);
    res.status(200).json({ success: true, message: 'Support ticket retrieved successfully', data });
});
exports.updateAny = catchAsync(async (req, res) => {
    const data = await svc.updateAny(req);
    res.status(200).json({ success: true, message: 'Support ticket updated', data });
});
exports.replyAny = catchAsync(async (req, res) => {
    const data = await svc.replyAny(req);
    res.status(200).json({ success: true, message: 'Reply added', data });
});
