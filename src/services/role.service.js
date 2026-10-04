const Role    = require('../modules/roles/role.model');
const Admin   = require('../modules/admins/admin.model');
const Library = require('../modules/libraries/library.model');

const err = (msg, status) => Object.assign(new Error(msg), { status });

exports.createRole = async (body, userId) =>
  Role.create({ ...body, createdBy: userId });

exports.listRoles = async (user) => {
  let filter = {};
  if (user.userType === 'admin') {
    filter = { $or: [{ createdBy: user._id }, { name: 'Staff', isDefault: true }] };
  } else if (user.userType !== 'superadmin') {
    filter = { createdBy: user.libraryId?.createdBy || user.libraryId };
  }
  return Role.find(filter).populate('permissionIds').populate('sidebarMenuIds');
};

exports.getRoleById = async (id) =>
  Role.findById(id).populate('permissionIds').populate('sidebarMenuIds');

exports.updateRole = async (id, body) => {
  const existing = await Role.findById(id);
  if (!existing) throw err('Role not found', 404);
  if (existing.isDefault) throw err('Cannot update default system roles', 400);
  return Role.findByIdAndUpdate(id, body, { new: true });
};

exports.deleteRole = async (id) => {
  const role = await Role.findById(id);
  if (!role) throw err('Role not found', 404);
  if (role.isDefault) throw err('Cannot delete default system roles', 400);
  const [adminCount, libCount] = await Promise.all([
    Admin.countDocuments({ roleId: id, isDeleted: false }),
    Library.countDocuments({ roleId: id, isDeleted: false }),
  ]);
  if (adminCount > 0 || libCount > 0) {
    const deps = [];
    if (adminCount > 0) deps.push(`${adminCount} Admin/Staff members`);
    if (libCount > 0)   deps.push(`${libCount} Library accounts`);
    throw err(`Cannot delete role. It is assigned to: ${deps.join(', ')}.`, 400);
  }
  await Role.findByIdAndDelete(id);
};
