const express = require('express');
const { exportLimiter } = require('../../middlewares/rateLimit.middleware');
const router = express.Router();
const c = require('../../controllers/report.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requirePermission } = require('../../middlewares/access.middleware');
const { reportValidation: v } = require('../../validations');

// Students never reach reports; staff need reports.view (owners and superadmin pass)
router.use(requireStaff, requirePermission('reports.view'));

router.get('/finance', validate(v.dateRangeQuery), c.getFinanceReport);
router.get('/students', validate(v.studentReportQuery), c.getStudentsReport);
router.get('/attendance', validate(v.attendanceQuery), c.getAttendanceReport);
router.get('/seats', validate(v.plainQuery), c.getSeatReport);
router.get('/pnl', validate(v.plainQuery), c.getPnLReport);
router.get('/membership', validate(v.membershipQuery), c.getMembershipReport);
router.get('/enquiries', validate(v.enquiryQuery), c.getEnquiryReport);
router.get('/branches', c.getBranchBreakdown);
router.get('/content', validate(v.plainQuery), c.getContentReport);
router.get('/complaints', validate(v.plainQuery), c.getComplaintReport);
router.get('/website', validate(v.plainQuery), c.getWebsiteReport);

// Generic paginated dataset (same query as the export)
router.get('/types', c.listTypes);
router.get('/data/:type', validate(v.dataQuery), c.getDataset);

// CSV / Excel (SpreadsheetML .xls) / JSON export of the full filtered dataset
router.get('/export', requirePermission('reports.export'), exportLimiter, validate(v.exportQuery), c.exportData);

// Business intelligence
router.get('/bi/overview', validate(v.biQuery), c.biOverview);
router.get('/bi/occupancy-trend', validate(v.biQuery), c.biOccupancyTrend);
router.get('/bi/revenue-trend', validate(v.biQuery), c.biRevenueTrend);
router.get('/bi/renewal-trend', validate(v.biQuery), c.biRenewalTrend);
router.get('/bi/outstanding-trend', validate(v.biQuery), c.biOutstandingTrend);
router.get('/bi/admission-trend', validate(v.biQuery), c.biAdmissionTrend);
router.get('/bi/enquiry-conversion', validate(v.biQuery), c.biEnquiryConversion);
router.get('/bi/seat-utilization', validate(v.biQuery), c.biSeatUtilization);
router.get('/bi/expiry-pipeline', validate(v.biQuery), c.biExpiryPipeline);
router.get('/bi/health', validate(v.biQuery), c.biHealth);
router.get('/bi/actions', validate(v.biQuery), c.biActions);

module.exports = router;
