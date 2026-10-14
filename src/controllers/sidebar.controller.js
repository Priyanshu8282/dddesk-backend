const catchAsync = require('../utils/catchAsync');
const svc        = require('../services/sidebar.service');
const audit      = require('../utils/audit');

exports.createSidebarMenu = catchAsync(async (req, res) => {
  const menu = await svc.createMenu(req.body);
  await audit(req, 'sidebar.create', 'SidebarMenu', menu._id, { title: menu.title });
  res.status(201).json({ success: true, message: 'Sidebar menu created successfully', data: menu });
});

exports.getSidebarMenus = catchAsync(async (req, res) => {
  const menus = await svc.getMenusForUser(req);
  res.status(200).json({ success: true, message: 'Sidebar menus retrieved successfully', data: menus });
});

exports.getAllSidebarMenus = catchAsync(async (req, res) => {
  const menus = await svc.getAllMenus();
  res.status(200).json({ success: true, message: 'All sidebar menus retrieved successfully', data: menus });
});

exports.updateSidebarMenu = catchAsync(async (req, res) => {
  const menu = await svc.updateMenu(req.params.id, req.body);
  await audit(req, 'sidebar.update', 'SidebarMenu', menu._id, { title: menu.title });
  res.status(200).json({ success: true, message: 'Sidebar menu updated successfully', data: menu });
});

exports.deleteSidebarMenu = catchAsync(async (req, res) => {
  const menu = await svc.deleteMenu(req.params.id);
  await audit(req, 'sidebar.delete', 'SidebarMenu', menu._id, { title: menu.title });
  res.status(200).json({ success: true, message: 'Sidebar menu deleted successfully' });
});
