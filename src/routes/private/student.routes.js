const express = require('express');
const studentController = require('../../controllers/student.controller');
const upload = require('../../middlewares/upload.middleware');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requireStudent, requirePermission } = require('../../middlewares/access.middleware');
const { studentValidation } = require('../../validations');
const { assertBranchAccess, isValidId } = require('../../utils/branchScope');
const Student = require('../../models/student.model');
const mongoose = require('mongoose');

const router = express.Router();

// Legacy keys + permission-catalog keys (spec 12) so default Staff/Receptionist/Manager roles work
const VIEW = ['VIEW_STUDENTS', 'students.view'];
const CREATE = ['CREATE_STUDENT', 'students.create'];
const EDIT = ['UPDATE_STUDENT', 'students.edit'];
const FEES_VIEW = ['fees.view', 'fees.collect']; // financial visibility is restricted (spec 12)
const ARCHIVE = ['DELETE_STUDENT', 'students.archive'];

// Student login is a public auth route (see auth routes); it is intentionally not mounted here.

// ---------------------------------------------------------------------------
// Student portal: a student can only ever act on their own record
// ---------------------------------------------------------------------------
router.get('/dashboard', requireStudent, studentController.getDashboard);
router.get('/me', requireStudent, studentController.getMyProfile);
router.put('/me', requireStudent, validate(studentValidation.updateMyProfile), studentController.updateMyProfile);
router.post('/me/renew-request', requireStudent, validate(studentValidation.renewRequest), studentController.requestRenewal);
router.post('/me/logout-all', requireStudent, studentController.logoutAll);
router.put('/change-password', requireStudent, validate(studentValidation.changePassword), studentController.changePassword);

// ---------------------------------------------------------------------------
// Everything below is staff / owner only
// ---------------------------------------------------------------------------
router.use(requireStaff);

// Branch-limited staff (Admin.branchIds non-empty) may only touch students of their own branches
router.param('id', async (req, res, next, id) => {
    try {
        if (req.userType === 'staff' && isValidId(id)) {
            const s = await Student.collection.findOne({ _id: new mongoose.Types.ObjectId(id), libraryId: req.libraryId }, { projection: { branchId: 1 } });
            if (s) assertBranchAccess(req, s.branchId);
        }
        next();
    } catch (e) { next(e); }
});

const uploadFields = upload.fields([
    { name: 'profileImage', maxCount: 1 },
    { name: 'aadhaarCardImage', maxCount: 2 },
    { name: 'documents', maxCount: 5 }
]);

router.post(
    '/create-student',
    requirePermission(...CREATE),
    uploadFields,
    validate(studentValidation.createStudent),
    studentController.createStudent
);

router.get('/export', requirePermission(...VIEW), validate(studentValidation.listStudents), studentController.exportStudents);
router.get('/get-students', requirePermission(...VIEW), validate(studentValidation.listStudents), studentController.getAllStudents);
router.get('/', requirePermission(...VIEW), validate(studentValidation.listStudents), studentController.getAllStudents);
router.get('/get-student/:id', requirePermission(...VIEW), studentController.getStudentById);

router.put(
    '/update-student/:id',
    requirePermission(...EDIT),
    uploadFields,
    validate(studentValidation.updateStudent),
    studentController.updateStudent
);

router.delete('/delete-student/:id', requirePermission(...ARCHIVE), studentController.deleteStudent);

// Plan assignment & payments
router.post('/assign-plan/:id', requirePermission(...EDIT), validate(studentValidation.assignPlan), studentController.assignPlan);
router.post('/mark-paid/:id', requirePermission(...EDIT, 'fees.collect'), validate(studentValidation.markAsPaid), studentController.markAsPaid);
router.get('/payment-history/:id', requirePermission(...FEES_VIEW), studentController.getPaymentHistory);

// Per-student resources
router.get('/:id/ledger', requirePermission(...FEES_VIEW), studentController.getLedger);
router.get('/:id/memberships', requirePermission(...VIEW), studentController.getMemberships);
router.post('/:id/change-plan', requirePermission(...EDIT), validate(studentValidation.changePlan), studentController.changePlan);
router.post('/:id/renew', requirePermission(...EDIT), validate(studentValidation.renew), studentController.renew);
router.post('/:id/membership/pause', requirePermission(...EDIT), validate(studentValidation.pauseMembership), studentController.pauseMembership);
router.post('/:id/membership/resume', requirePermission(...EDIT), validate(studentValidation.resumeMembership), studentController.resumeMembership);
router.post('/:id/membership/extend', requirePermission(...EDIT), validate(studentValidation.extendMembership), studentController.extendMembership);
router.patch('/:id/status', requirePermission(...EDIT), validate(studentValidation.setStatus), studentController.setStatus);
router.post('/:id/notes', requirePermission(...EDIT), validate(studentValidation.addNote), studentController.addNote);
router.get('/:id/notes', requirePermission(...VIEW), studentController.getNotes);
router.post('/:id/reset-password', requirePermission(...EDIT), studentController.resetPassword);

router.get('/:id', requirePermission(...VIEW), studentController.getStudentById);

module.exports = router;
