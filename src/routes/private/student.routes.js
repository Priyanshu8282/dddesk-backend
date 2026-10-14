const express = require('express');
const studentController = require('../../controllers/student.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { studentValidation } = require('../../validations');

const router = express.Router();

// Public student login (mounted also under students for portal compatibility)
router.post('/login', studentController.loginStudent);

// Student portal dashboard
router.get('/dashboard', studentController.getDashboard);

// Student management
router.post(
    '/create-student',
    upload.fields([
        { name: 'profileImage', maxCount: 1 },
        { name: 'aadhaarCardImage', maxCount: 2 }
    ]),
    validate(studentValidation.createStudent),
    studentController.createStudent
);

router.get('/get-students', studentController.getAllStudents);
router.get('/get-student/:id', studentController.getStudentById);

router.put(
    '/update-student/:id',
    upload.fields([
        { name: 'profileImage', maxCount: 1 },
        { name: 'aadhaarCardImage', maxCount: 2 }
    ]),
    studentController.updateStudent
);

router.delete('/delete-student/:id', studentController.deleteStudent);

// Plan assignment & payments
router.post('/assign-plan/:id', validate(studentValidation.assignPlan), studentController.assignPlan);
router.post('/mark-paid/:id', validate(studentValidation.markAsPaid), studentController.markAsPaid);
router.get('/payment-history/:id', studentController.getPaymentHistory);
router.put('/change-password', studentController.changePassword);

module.exports = router;
