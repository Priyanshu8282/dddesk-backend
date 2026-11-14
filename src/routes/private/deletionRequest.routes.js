const express = require('express');
const c = require('../../controllers/deletionRequest.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStudent, requireStaff, requirePermission, requireOwner, requireSuperAdmin, blockImpersonation } = require('../../middlewares/access.middleware');
const v = require('../../validations/deletionRequest.validation');

// Student self-service: request only - nothing is erased until staff/owner approves it (mounted at /students/me/deletion-request)
const student = express.Router();
student.use(requireStudent);
student.post('/', validate(v.requestDeletion), c.requestMine);
student.get('/', c.getMine);
student.delete('/', c.cancelMine);

// Staff/owner review queue for student requests (mounted at /students/deletion-requests)
const staffReview = express.Router();
staffReview.use(requireStaff, requirePermission('students.erase'));
staffReview.get('/', validate(v.list), c.listStudentRequests);
staffReview.post('/:id/approve', validate(v.idParam), c.approveStudentRequest);
staffReview.post('/:id/reject', validate(v.reject), c.rejectStudentRequest);

// Library owner self-service: request only - a superadmin reviews it manually (mounted at /libraries/deletion-request)
const owner = express.Router();
owner.use(requireOwner, blockImpersonation);
owner.post('/', validate(v.requestDeletion), c.requestLibraryDeletion);
owner.get('/', c.getMyLibraryRequest);
owner.delete('/', c.cancelMyLibraryRequest);

// Superadmin review queue for library requests (mounted at /super/libraries/deletion-requests)
const superAdmin = express.Router();
superAdmin.use(requireSuperAdmin);
superAdmin.get('/', validate(v.list), c.listLibraryRequests);
superAdmin.post('/:id/review', validate(v.review), c.reviewLibraryRequest);

module.exports = { student, staffReview, owner, superAdmin };
