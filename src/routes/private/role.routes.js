const express = require('express');
const roleController = require('../../controllers/role.controller');

const router = express.Router();

router.post('/create-role', roleController.createRole);
router.get('/get-roles', roleController.getRoles);
router.get('/get-role/:id', roleController.getRoleById);
router.put('/update-role/:id', roleController.updateRole);
router.delete('/delete-role/:id', roleController.deleteRole);

module.exports = router;
