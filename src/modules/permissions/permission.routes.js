const express = require('express');
const router = express.Router();
const permissionController = require('./permission.controller');
const authMiddleware = require('../../middlewares/auth.middleware');
const permissionMiddleware = require('../../middlewares/permission.middleware');

router.use(authMiddleware);

router.post('/', permissionMiddleware('CREATE_PERMISSION'), permissionController.createPermission);
router.get('/', permissionMiddleware('VIEW_PERMISSIONS'), permissionController.getPermissions);
router.put('/:id', permissionMiddleware('UPDATE_PERMISSION'), permissionController.updatePermission);
router.delete('/:id', permissionMiddleware('DELETE_PERMISSION'), permissionController.deletePermission);

module.exports = router;
