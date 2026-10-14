const express = require('express');
const attendanceController = require('../../controllers/attendance.controller');
const validate = require('../../middlewares/validate.middleware');
const { attendanceValidation } = require('../../validations');

const router = express.Router();

// QR-based dynamic rotating attendance
router.get('/generate-qr', attendanceController.generateQR);
router.post('/scan-qr', validate(attendanceValidation.scanQR), attendanceController.scanQR);

// Admin live view
router.get('/today', attendanceController.getToday);
router.get('/active', attendanceController.getActive);
router.post('/manual-close/:id', attendanceController.manualClose);

// Attendance history & legacy endpoints
router.get('/list', attendanceController.getAttendance);
router.post('/punch-in', attendanceController.punchIn);
router.post('/punch-out', attendanceController.punchOut);

module.exports = router;
