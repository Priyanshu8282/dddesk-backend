const express = require('express');
const Authentication = require('../../middlewares/auth.middleware');
const attendanceController = require('./attendance.controller');

const router = express.Router();

router.post('/punch-in', Authentication, attendanceController.punchIn);
router.post('/punch-out', Authentication, attendanceController.punchOut);
router.get('/list', Authentication, attendanceController.getAttendance);

module.exports = router;
