const express = require('express');
const permissionController = require('../../controllers/permission.controller');

const router = express.Router();

router.post('/create-permission', permissionController.createPermission);
router.get('/get-permissions', permissionController.getPermissions);
router.put('/update-permission/:id', permissionController.updatePermission);
router.delete('/delete-permission/:id', permissionController.deletePermission);

module.exports = router;
