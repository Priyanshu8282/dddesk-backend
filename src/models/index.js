const Admin = require('../modules/admins/admin.model');
const Role = require('../modules/roles/role.model');
const Permission = require('../modules/permissions/permission.model');
const SidebarMenu = require('../modules/sidebar/sidebar.model');

module.exports = {
    Admins: Admin,
    adminRoles: Role,
    Permission: Permission,
    SidebarMenu: SidebarMenu
};
