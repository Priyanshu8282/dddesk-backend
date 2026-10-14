const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/ApiResponse');
const audit = require('../utils/audit');
const complaintService = require('../services/complaint.service');
const { branchFilter } = require('../utils/branchScope');

const files = (req) => (Array.isArray(req.files) ? req.files : req.file ? [req.file] : []);

exports.createComplaint = catchAsync(async (req, res) => {
    const complaint = await complaintService.createComplaint(req.body, req.user, files(req), req.libraryId);
    if (req.userType !== 'student') audit(req, 'complaint.create', 'Complaint', complaint._id);
    ApiResponse.created(res, complaint, 'Complaint ticket created successfully');
});

const sendList = (res, result, message) =>
    ApiResponse.ok(res, result.data, message, {
        total: result.total, page: result.page, totalPages: result.totalPages, limit: result.limit
    });

// Staff: all tickets of the library
exports.getComplaints = catchAsync(async (req, res) => {
    const result = await complaintService.listComplaints(req.libraryId, req.query || {}, req.user, branchFilter(req));
    sendList(res, result, 'Complaints retrieved successfully');
});

// Student: only own tickets
exports.getMyComplaints = catchAsync(async (req, res) => {
    const result = await complaintService.listComplaints(req.libraryId, req.query || {}, req.user, branchFilter(req));
    sendList(res, result, 'My complaints retrieved successfully');
});

exports.getComplaintById = catchAsync(async (req, res) => {
    const complaint = await require('../utils/securityEvent').flagOnMiss(req, require('../models/complaint.model'), req.params.id, 'Complaint',
        () => complaintService.getComplaintById(req.params.id, req.libraryId, req.user));
    ApiResponse.ok(res, complaint, 'Complaint details retrieved successfully');
});

exports.updateComplaint = catchAsync(async (req, res) => {
    const updated = await complaintService.updateComplaint(req.params.id, req.libraryId, req.body, req.user, files(req));
    ApiResponse.ok(res, updated, 'Complaint updated successfully');
});

exports.updateStatus = catchAsync(async (req, res) => {
    const { status, resolutionNote, cost } = req.body;
    const updated = await complaintService.updateStatus(req.params.id, req.libraryId, status, resolutionNote, cost, req.user);
    audit(req, 'complaint.status', 'Complaint', req.params.id, { status });
    ApiResponse.ok(res, updated, `Ticket status successfully changed to ${status}`);
});

exports.assignStaff = catchAsync(async (req, res) => {
    const { assignedTo, notes } = req.body;
    const updated = await complaintService.assignStaff(req.params.id, req.libraryId, assignedTo, notes, req.user);
    audit(req, 'complaint.assign', 'Complaint', req.params.id, { assignedTo });
    ApiResponse.ok(res, updated, 'Staff assigned to ticket successfully');
});

exports.addNote = catchAsync(async (req, res) => {
    const updated = await complaintService.addNote(req.params.id, req.libraryId, req.body, req.user);
    ApiResponse.ok(res, updated, 'Note added to ticket successfully');
});

exports.deleteComplaint = catchAsync(async (req, res) => {
    await complaintService.deleteComplaint(req.params.id, req.libraryId);
    audit(req, 'complaint.delete', 'Complaint', req.params.id);
    ApiResponse.ok(res, null, 'Complaint ticket deleted successfully');
});

exports.getStats = catchAsync(async (req, res) => {
    const stats = await complaintService.getStats(req.libraryId, branchFilter(req));
    ApiResponse.ok(res, stats, 'Complaint statistics retrieved successfully');
});

exports.getMaintenanceHistory = catchAsync(async (req, res) => {
    const result = await complaintService.getMaintenanceHistory(req.libraryId, req.query, branchFilter(req));
    ApiResponse.ok(res, result.data, 'Maintenance history retrieved successfully', {
        total: result.total, page: result.page, totalPages: result.totalPages, limit: result.limit, totalCost: result.totalCost
    });
});

exports.getRecurringIssues = catchAsync(async (req, res) => {
    const data = await complaintService.getRecurringIssues(req.libraryId, {
        days: req.query.days || 30, min: req.query.min || 3
    }, branchFilter(req));
    ApiResponse.ok(res, data, 'Recurring issues retrieved successfully');
});
