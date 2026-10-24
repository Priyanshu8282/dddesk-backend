const express = require('express');
const attendanceController = require('../../controllers/attendance.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireStudent, requirePermission } = require('../../middlewares/access.middleware');
const { attendanceValidation: v } = require('../../validations');

const router = express.Router();

// ── Student-only ─────────────────────────────────────────────────────────────
router.get('/my', requireStudent, validate(v.myQuery), attendanceController.getMy);
router.post('/self-check', requireStudent, validate(v.selfCheck), attendanceController.selfCheck);
router.post('/scan-qr', requireStudent, validate(v.scanQR), attendanceController.scanQR);

// ── Staff-only (everything below) ────────────────────────────────────────────
router.use(requireStaff);

router.get('/generate-qr', requirePermission('attendance.checkin', 'attendance.correct'), attendanceController.generateQR);

// Live views
router.get('/today', requirePermission('attendance.view'), attendanceController.getToday);
router.get('/active', requirePermission('attendance.view'), attendanceController.getActive);
router.get('/trend', requirePermission('attendance.view'), attendanceController.getTrend);
router.get('/export', requirePermission('attendance.view'), validate(v.listQuery), attendanceController.exportList);
router.get('/list', requirePermission('attendance.view'), validate(v.listQuery), attendanceController.getAttendance);

// Reports
router.get('/percentage', requirePermission('attendance.view'), validate(v.rangeQuery), attendanceController.percentage);
router.get('/student/:id/summary', requirePermission('attendance.view'), validate(v.studentRangeQuery), attendanceController.studentSummary);

// Marking
router.post('/manual', requirePermission('attendance.checkin', 'attendance.checkout'), validate(v.manualMark), attendanceController.markManual);
router.post('/leave', requirePermission('attendance.checkin', 'attendance.correct'), validate(v.leave), attendanceController.markLeave);
router.post('/manual-close/:id', requirePermission('attendance.checkout', 'attendance.correct'), validate(v.manualClose), attendanceController.manualClose);
router.patch('/:id/correct', requirePermission('attendance.correct'), validate(v.correct), attendanceController.correct);

// Legacy aliases (staff only; students use /self-check or /scan-qr)
router.post('/punch-in', requirePermission('attendance.checkin'), validate(v.manualPunch), attendanceController.punchIn);
router.post('/punch-out', requirePermission('attendance.checkout'), validate(v.manualPunch), attendanceController.punchOut);

module.exports = router;
