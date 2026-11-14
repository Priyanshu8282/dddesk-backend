const catchAsync = require('../utils/catchAsync');
const svc = require('../services/deletionRequest.service');

const lib = (req) => (req.libraryId);

// ---- student (self) ----
exports.requestMine = catchAsync(async (req, res) => {
    const data = await svc.requestStudentDeletion(req.user._id, lib(req), req.body.reason, req);
    res.status(201).json({ success: true, message: 'Deletion request submitted. Your library will review it.', data });
});
exports.getMine = catchAsync(async (req, res) => {
    const data = await svc.getMyStudentRequest(req.user._id);
    res.status(200).json({ success: true, message: 'Deletion request status retrieved', data });
});
exports.cancelMine = catchAsync(async (req, res) => {
    const data = await svc.cancelMyStudentRequest(req.user._id, req);
    res.status(200).json({ success: true, message: 'Deletion request cancelled', data });
});

// ---- staff / owner (review student requests) ----
exports.listStudentRequests = catchAsync(async (req, res) => {
    const r = await svc.listStudentRequests(lib(req), req.query);
    res.status(200).json({ success: true, message: 'Deletion requests retrieved successfully', ...r });
});
exports.approveStudentRequest = catchAsync(async (req, res) => {
    const data = await svc.approveStudentRequest(req.params.id, lib(req), req);
    res.status(200).json({ success: true, message: 'Request approved; the student\'s personal data has been erased', data });
});
exports.rejectStudentRequest = catchAsync(async (req, res) => {
    const data = await svc.rejectStudentRequest(req.params.id, lib(req), req.body.note, req);
    res.status(200).json({ success: true, message: 'Request declined', data });
});

// ---- library owner (self) ----
exports.requestLibraryDeletion = catchAsync(async (req, res) => {
    const data = await svc.requestLibraryDeletion(lib(req), req.user._id, req.body.reason, req);
    res.status(201).json({ success: true, message: 'Deletion request submitted for platform review', data });
});
exports.getMyLibraryRequest = catchAsync(async (req, res) => {
    const data = await svc.getMyLibraryRequest(lib(req));
    res.status(200).json({ success: true, message: 'Deletion request status retrieved', data });
});
exports.cancelMyLibraryRequest = catchAsync(async (req, res) => {
    const data = await svc.cancelMyLibraryRequest(lib(req), req);
    res.status(200).json({ success: true, message: 'Deletion request cancelled', data });
});

// ---- superadmin (review library requests) ----
exports.listLibraryRequests = catchAsync(async (req, res) => {
    const r = await svc.listLibraryRequests(req.query);
    res.status(200).json({ success: true, message: 'Deletion requests retrieved successfully', ...r });
});
exports.reviewLibraryRequest = catchAsync(async (req, res) => {
    const data = await svc.reviewLibraryRequest(req.params.id, req.body.status, req.body.note, req);
    res.status(200).json({ success: true, message: 'Request reviewed', data });
});
