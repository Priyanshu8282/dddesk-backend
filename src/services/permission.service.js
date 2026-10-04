const Permission = require('../modules/permissions/permission.model');
const Role       = require('../modules/roles/role.model');

const err = (msg, status) => Object.assign(new Error(msg), { status });

exports.createPermission = async (body) => Permission.create(body);

exports.listPermissions = async () => Permission.find();

exports.updatePermission = async (id, body) => {
  const p = await Permission.findByIdAndUpdate(id, body, { new: true });
  if (!p) throw err('Permission not found', 404);
  return p;
};

exports.deletePermission = async (id) => {
  const role = await Role.findOne({ permissionIds: id });
  if (role) throw err(`Cannot delete permission. It is assigned to the '${role.name}' role.`, 400);
  const p = await Permission.findByIdAndDelete(id);
  if (!p) throw err('Permission not found', 404);
};
