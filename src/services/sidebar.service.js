const SidebarMenu = require('../modules/sidebar/sidebar.model');
const Role        = require('../modules/roles/role.model');

const err = (msg, status) => Object.assign(new Error(msg), { status });

exports.getMenusForUser = async (user, userType) => {
  const sort = { module_priority: 1, module_menu_priority: 1 };

  if (userType === 'student')
    return SidebarMenu.find({ userType: 'student' }).sort(sort);

  if (user.userType === 'superadmin')
    return SidebarMenu.find({ userType: { $nin: ['student'] }, title: { $nin: ['Role Management','Access Control'] } }).sort(sort);

  if (user.userType === 'admin')
    return SidebarMenu.find({ userType: { $nin: ['student'] }, title: { $nin: ['Libraries','Library Management'] } }).sort(sort);

  // Staff: role-based menus
  await user.populate('roleId');
  if (!user.roleId) return [];
  return SidebarMenu.find({ _id: { $in: user.roleId.sidebarMenuIds } }).sort(sort);
};

exports.getAllMenus = async () =>
  SidebarMenu.find().sort({ module_priority: 1, module_menu_priority: 1 });

exports.createMenu = async (body) => SidebarMenu.create(body);

exports.updateMenu = async (id, body) =>
  SidebarMenu.findByIdAndUpdate(id, body, { new: true });

exports.deleteMenu = async (id) => {
  const role = await Role.findOne({ sidebarMenuIds: id });
  if (role) throw err(`Cannot delete menu item. It is assigned to the '${role.name}' role.`, 400);
  const menu = await SidebarMenu.findByIdAndDelete(id);
  if (!menu) throw err('Menu item not found', 404);
};
