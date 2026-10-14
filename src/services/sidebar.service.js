const SidebarMenu = require('../models/sidebar.model');
const Role        = require('../models/role.model');
const pick        = require('../utils/pick');

const err = (msg, status) => Object.assign(new Error(msg), { status });

const FIELDS = ['title', 'iconStyle', 'to', 'parent_module_id', 'module_menu_priority', 'module_id', 'module_priority',
  'classChange', 'classsChange', 'extraClass', 'extraclass', 'hasMenu', 'userType', 'content'];

// Priorities are stored as strings ("10" sorts before "2" in Mongo); sort numerically here.
// Missing priority sorts first (same as Mongo's null ordering) so existing client grouping keeps working.
const prio = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : -Infinity;
};
const sortMenus = (menus) =>
  menus.sort((a, b) =>
    (prio(a.module_priority) - prio(b.module_priority) || 0) ||
    (prio(a.module_menu_priority) - prio(b.module_menu_priority) || 0) ||
    String(a.title).localeCompare(String(b.title)));
// Infinity - Infinity is NaN; the `|| 0` above turns it into a tie

exports.getMenusForUser = async (req) => {
  const user = req.user;
  const userType = req.userType;
  let menus;

  if (userType === 'student') {
    menus = await SidebarMenu.find({ userType: 'student' }).lean();
  } else if (userType === 'superadmin') {
    menus = await SidebarMenu.find({
      userType: { $nin: ['student', 'staff'] },
      title: { $nin: ['Role Management', 'Access Control'] },
    }).lean();
  } else if (userType === 'admin') {
    menus = await SidebarMenu.find({
      userType: { $nin: ['student', 'superadmin'] },
      title: { $nin: ['Libraries', 'Library Management'] },
    }).lean();
  } else {
    // Staff: role-based menus
    const ids = user.roleId?.sidebarMenuIds || [];
    if (!ids.length) return [];
    menus = await SidebarMenu.find({ _id: { $in: ids }, userType: { $nin: ['student', 'superadmin'] } }).lean();
  }
  return sortMenus(menus);
};

exports.getAllMenus = async () => sortMenus(await SidebarMenu.find().lean());

exports.createMenu = async (body) => SidebarMenu.create(pick(body, FIELDS));

exports.updateMenu = async (id, body) => {
  const menu = await SidebarMenu.findByIdAndUpdate(id, { $set: pick(body, FIELDS) }, { new: true, runValidators: true });
  if (!menu) throw err('Menu item not found', 404);
  return menu;
};

exports.deleteMenu = async (id) => {
  const role = await Role.findOne({ sidebarMenuIds: id });
  if (role) throw err(`Cannot delete menu item. It is assigned to the '${role.name}' role.`, 400);
  const menu = await SidebarMenu.findByIdAndDelete(id);
  if (!menu) throw err('Menu item not found', 404);
  return menu;
};
