const express = require('express');
const sidebarController = require('../../controllers/sidebar.controller');

const router = express.Router();

router.post('/create-menu', sidebarController.createSidebarMenu);
router.get('/get-menus', sidebarController.getSidebarMenus);
router.get('/get-all-menus', sidebarController.getAllSidebarMenus);
router.put('/update-menu/:id', sidebarController.updateSidebarMenu);
router.delete('/delete-menu/:id', sidebarController.deleteSidebarMenu);

module.exports = router;
