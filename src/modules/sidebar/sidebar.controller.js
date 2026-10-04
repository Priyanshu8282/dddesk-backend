const catchAsync = require('../../utils/catchAsync');
const svc        = require('../../services/sidebar.service');

exports.createSidebarMenu = catchAsync(async (req, res) => {
  const menu = await svc.createMenu(req.body);
  res.status(201).json(menu);
});

exports.getSidebarMenus = catchAsync(async (req, res) => {
  const menus = await svc.getMenusForUser(req.user, req.userType);
  res.json(menus);
});

exports.getAllSidebarMenus = catchAsync(async (req, res) => {
  const menus = await svc.getAllMenus();
  res.json(menus);
});

exports.updateSidebarMenu = catchAsync(async (req, res) => {
  const menu = await svc.updateMenu(req.params.id, req.body);
  res.json(menu);
});

exports.deleteSidebarMenu = catchAsync(async (req, res) => {
  await svc.deleteMenu(req.params.id);
  res.json({ message: 'Menu item deleted' });
});
