const catchAsync = require('../utils/catchAsync');
const svc        = require('../services/sidebar.service');

exports.createSidebarMenu = catchAsync(async (req, res) => {
  const menu = await svc.createMenu(req.body);
  res.status(201).json({
    success: true,
    message: 'Sidebar menu created successfully',
    data: menu
  });
});

exports.getSidebarMenus = catchAsync(async (req, res) => {
  const menus = await svc.getMenusForUser(req.user, req.userType);
  res.status(200).json({
    success: true,
    message: 'Sidebar menus retrieved successfully',
    data: menus
  });
});

exports.getAllSidebarMenus = catchAsync(async (req, res) => {
  const menus = await svc.getAllMenus();
  res.status(200).json({
    success: true,
    message: 'All sidebar menus retrieved successfully',
    data: menus
  });
});

exports.updateSidebarMenu = catchAsync(async (req, res) => {
  const menu = await svc.updateMenu(req.params.id, req.body);
  res.status(200).json({
    success: true,
    message: 'Sidebar menu updated successfully',
    data: menu
  });
});

exports.deleteSidebarMenu = catchAsync(async (req, res) => {
  await svc.deleteMenu(req.params.id);
  res.status(200).json({
    success: true,
    message: 'Sidebar menu deleted successfully'
  });
});
