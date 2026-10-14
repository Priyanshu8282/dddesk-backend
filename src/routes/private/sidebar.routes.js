const express = require('express');
const sidebarController = require('../../controllers/sidebar.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireSuperAdmin, requireOwner } = require('../../middlewares/access.middleware');
const v = require('../../validations/platform.validation');

const router = express.Router();

// Any authenticated account (incl. students) gets the menus for its own user type
router.get('/get-menus', sidebarController.getSidebarMenus);
// Full catalogue (used by the role editor)
router.get('/get-all-menus', requireOwner, sidebarController.getAllSidebarMenus);

// Menu definitions are platform managed: superadmin only
router.post('/create-menu', requireSuperAdmin, validate(v.createMenu), sidebarController.createSidebarMenu);
router.put('/update-menu/:id', requireSuperAdmin, validate(v.updateMenu), sidebarController.updateSidebarMenu);
router.delete('/delete-menu/:id', requireSuperAdmin, validate(v.idParam), sidebarController.deleteSidebarMenu);

module.exports = router;
