const express = require('express');
const router = express.Router();
const complaintController = require('../../controllers/complaint.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireStudent, requirePermission } = require('../../middlewares/access.middleware');
const { complaintValidation: v } = require('../../validations');
const { paramGuard } = require('../../utils/branchScope');
router.param('id', paramGuard(require('../../models/complaint.model')));

// Students pass through (the service limits them to their own tickets); staff need the permission
const staffPerm = (...keys) => (req, res, next) => (req.userType === 'student' ? next() : requirePermission(...keys)(req, res, next));

// ── Staff-only reports (static paths first so /:id never captures them) ─────
router.get('/stats', requireStaff, requirePermission('complaints.view'), complaintController.getStats);
router.get('/maintenance-history', requireStaff, requirePermission('complaints.view'), validate(v.maintenanceHistoryQuery), complaintController.getMaintenanceHistory);
router.get('/recurring', requireStaff, requirePermission('complaints.view'), validate(v.recurringQuery), complaintController.getRecurringIssues);

// ── Student: own tickets ────────────────────────────────────────────────────
router.get('/my', requireStudent, validate(v.getComplaintsQuery), complaintController.getMyComplaints);

// ── Staff: all tickets ──────────────────────────────────────────────────────
router.get('/', requireStaff, requirePermission('complaints.view'), validate(v.getComplaintsQuery), complaintController.getComplaints);

// ── Staff or student (students are limited to their own tickets in the service) ──
router.post('/', staffPerm('complaints.view', 'complaints.resolve'), upload.array('images', 5), validate(v.createComplaint), complaintController.createComplaint);
router.get('/:id', staffPerm('complaints.view'), validate(v.idParam), complaintController.getComplaintById);
router.post('/:id/notes', staffPerm('complaints.view'), validate(v.addNote), complaintController.addNote);
router.put('/:id', staffPerm('complaints.resolve'), upload.array('images', 5), validate(v.updateComplaint), complaintController.updateComplaint);

// ── Staff-only lifecycle ────────────────────────────────────────────────────
router.patch('/:id/status', requireStaff, requirePermission('complaints.resolve'), validate(v.updateStatus), complaintController.updateStatus);
router.patch('/:id/assign', requireStaff, requirePermission('complaints.assign'), validate(v.assignComplaint), complaintController.assignStaff);
router.delete('/:id', requireStaff, requirePermission('complaints.resolve'), validate(v.idParam), complaintController.deleteComplaint);

module.exports = router;
