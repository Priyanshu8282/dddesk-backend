const express = require('express');
const studentController = require('./student.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

const upload = require('../../middlewares/upload.middleware');

const router = express.Router();

// Public routes
router.post('/login', studentController.loginStudent);

// Protected routes
router.use(authMiddleware);

router.post('/create-student', upload.fields([
    { name: 'profileImage', maxCount: 1 },
    { name: 'aadhaarCardImage', maxCount: 2 }
]), studentController.createStudent);
router.get('/dashboard', studentController.getDashboard);
router.get('/get-students', studentController.getAllStudents);
router.get('/get-student/:id', studentController.getStudentById);
router.put('/update-student/:id', upload.fields([
    { name: 'profileImage', maxCount: 1 },
    { name: 'aadhaarCardImage', maxCount: 2 }
]), studentController.updateStudent);
router.delete('/delete-student/:id', studentController.deleteStudent);

// Plan & Payment management
router.post('/assign-plan/:id', studentController.assignPlan);
router.post('/mark-paid/:id', studentController.markAsPaid);
router.get('/payment-history/:id', studentController.getPaymentHistory);
router.put('/change-password', studentController.changePassword);


module.exports = router;
