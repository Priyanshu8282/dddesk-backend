const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const { tenantId } = require('../middlewares/access.middleware');
const { oid, parseQuery } = require('../services/reportQuery');
const reportService = require('../services/report.service');
const bi = require('../services/reportBi.service');
const { streamExport } = require('../services/reportExport');
const { branchFilter, allowedBranchIds } = require('../utils/branchScope');

// Merge the caller's branch scope into a parsed report query:
//  - owner/superadmin: optional ?branchId= (otherwise consolidated, all branches)
//  - branch-limited staff: forced to their branches (q.branchIds), or one of them via ?branchId=
const withBranchScope = (req, q) => {
    const f = branchFilter(req);
    q.branchId = undefined;
    q.branchIds = undefined;
    if (f.branchId && f.branchId.$in) q.branchIds = f.branchId.$in;
    else if (f.branchId) q.branchId = String(f.branchId);
    return q;
};
const parse = (req, opts) => withBranchScope(req, parseQuery(req.query, opts));

// Tenant as ObjectId (superadmin may target a tenant via ?libraryId=; everyone else is pinned to their own library)
const scope = (req) => {
    const id = tenantId(req);
    if (!id) throw new ApiError(400, 'Library context required');
    return oid(id);
};

const respond = (message, fn, parseOpts) => catchAsync(async (req, res) => {
    const L = scope(req);
    const data = await fn(L, parse(req, parseOpts), req);
    res.status(200).json({ success: true, message, data });
});

// Report endpoints. Students/membership lists default to no date window; money/attendance default to the current IST month.
exports.getFinanceReport = respond('Finance report generated successfully', reportService.getFinanceReport);
exports.getStudentsReport = respond('Students report generated successfully', reportService.getStudentsReport, { defaultRange: 'none' });
exports.getAttendanceReport = respond('Attendance report generated successfully', reportService.getAttendanceReport);
exports.getSeatReport = respond('Seat occupancy report generated successfully', reportService.getSeatReport, { defaultRange: 'none' });
exports.getPnLReport = respond('P&L report generated successfully', reportService.getPnLReport);
exports.getMembershipReport = respond('Membership report generated successfully', reportService.getMembershipReport, { defaultRange: 'none' });
exports.getEnquiryReport = respond('Enquiry report generated successfully', reportService.getEnquiryReport, { defaultRange: 'none' });
exports.getContentReport = respond('Content report generated successfully', reportService.getContentReport, { defaultRange: 'none' });
exports.getComplaintReport = respond('Complaint report generated successfully', reportService.getComplaintReport, { defaultRange: 'none' });
exports.getWebsiteReport = respond('Website report generated successfully', reportService.getWebsiteReport, { defaultRange: 'none' });

exports.getDataset = catchAsync(async (req, res) => {
    const L = scope(req);
    const data = await reportService.getDataset(req.params.type, L, parse(req, { defaultRange: 'none' }));
    res.status(200).json({ success: true, message: 'Report data retrieved successfully', data });
});

// GET /reports/branches : per-branch comparison (students, seats, today's collection, pending dues, attendance)
exports.getBranchBreakdown = catchAsync(async (req, res) => {
    const L = scope(req);
    const allowed = allowedBranchIds(req);
    const data = await reportService.getBranchBreakdown(L, allowed);
    res.status(200).json({ success: true, message: 'Branch breakdown generated successfully', data });
});

exports.listTypes = catchAsync(async (req, res) => {
    res.status(200).json({ success: true, data: reportService.listTypes() });
});

// ---- BI (default window: last 30 days; month granularity: last 12 months) ----
const biHandler = (message, fn, defaultRange = 30) => catchAsync(async (req, res) => {
    const L = scope(req);
    const q = parse(req, { defaultRange: req.query.granularity === 'month' && defaultRange === 30 ? 365 : defaultRange });
    q.listLimit = req.query.listLimit;
    res.status(200).json({ success: true, message, data: await fn(L, q) });
});
exports.biOccupancyTrend = biHandler('Occupancy trend', bi.occupancyTrend);
exports.biRevenueTrend = biHandler('Revenue trend', bi.revenueTrend);
exports.biRenewalTrend = biHandler('Renewal trend', bi.renewalTrend, 180);
exports.biOutstandingTrend = biHandler('Outstanding fee trend', bi.outstandingTrend, 180);
exports.biAdmissionTrend = biHandler('Admission trend', bi.admissionTrend);
exports.biEnquiryConversion = biHandler('Enquiry conversion', bi.enquiryConversion, 90);
exports.biSeatUtilization = biHandler('Seat utilization', bi.seatUtilization);
exports.biExpiryPipeline = biHandler('Membership expiry pipeline', bi.expiryPipeline);
exports.biHealth = biHandler('Business health', bi.healthScore);
exports.biActions = biHandler('Action list', bi.actionList);
exports.biOverview = biHandler('BI overview', bi.overview);

// ---- Export: full filtered dataset, streamed (no page limit) ----
exports.exportData = async (req, res, next) => {
    try {
        const L = scope(req);
        const { type, format } = req.query;
        const q = parse(req, { defaultRange: 'none' });

        if (format === 'json') {
            const result = await reportService.exportJson(type, L, q);
            audit(req, 'report.export', 'Report', null, { type, format, rows: result.count });
            return res.status(200).json({ success: true, message: 'Data exported successfully', ...result });
        }

        try {
            const { rows } = await streamExport(res, { type, format, L, q });
            audit(req, 'report.export', 'Report', null, { type, format, rows, startDate: req.query.startDate, endDate: req.query.endDate });
        } catch (err) {
            if (res.headersSent) {
                // Mid-stream failure: cannot send JSON any more; abort the connection so the client sees an incomplete download
                console.error('Report export aborted:', err.message);
                return res.destroy(err);
            }
            res.removeHeader('Content-Disposition');
            res.removeHeader('Content-Type');
            throw err;
        }
    } catch (err) {
        return next(err);
    }
};
