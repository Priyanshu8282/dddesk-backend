const express = require('express');
const router = express.Router();
const roleController = require('./role.controller');
const Authentication = require('../../middlewares/auth.middleware');
const Authorization = require('../../middlewares/authorization.middleware');

router.post('/create-role', Authentication, Authorization, roleController.createRole);
router.get('/get-roles', Authentication, Authorization, roleController.getRoles);
router.get('/get-role/:id', Authentication, Authorization, roleController.getRoleById);
router.put('/update-role/:id', Authentication, Authorization, roleController.updateRole);
router.delete('/delete-role/:id', Authentication, Authorization, roleController.deleteRole);

module.exports = router;
