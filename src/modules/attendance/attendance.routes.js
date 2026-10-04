const express = require('express');
const Authentication = require('../../middlewares/auth.middleware');
const attendanceController = require('./attendance.controller');

const router = express.Router();

// ─── QR-based attendance (secure) ────────────────────────────────────────────
router.get('/generate-qr', Authentication, attendanceController.generateQR);       // Admin polls every 60s
router.post('/scan-qr', Authentication, attendanceController.scanQR);              // Student scans

// ─── Admin views ─────────────────────────────────────────────────────────────
router.get('/today', Authentication, attendanceController.getToday);               // Today's full list
router.get('/active', Authentication, attendanceController.getActive);             // Currently inside
router.post('/manual-close/:id', Authentication, attendanceController.manualClose); // Admin closes missed checkout

// ─── History / list ──────────────────────────────────────────────────────────
router.get('/list', Authentication, attendanceController.getAttendance);           // Legacy + history

// ─── Legacy endpoints (kept for backward compat) ─────────────────────────────
router.post('/punch-in', Authentication, attendanceController.punchIn);
router.post('/punch-out', Authentication, attendanceController.punchOut);

module.exports = router;
