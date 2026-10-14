const Permission = require('../models/permission.model');
const Role       = require('../models/role.model');
const pick       = require('../utils/pick');

const err = (msg, status) => Object.assign(new Error(msg), { status });

exports.createPermission = async (body) =>
  Permission.create(pick(body, ['name', 'key', 'module', 'route', 'description', 'scope']));

// Tenants never see platform-scope permissions; `grouped` returns { module: [permissions] }
exports.listPermissions = async ({ includePlatform = false, grouped = false } = {}) => {
  const filter = includePlatform ? {} : { scope: { $ne: 'platform' } };
  const list = await Permission.find(filter).sort({ module: 1, key: 1 });
  if (!grouped) return list;
  return list.reduce((acc, p) => { (acc[p.module] = acc[p.module] || []).push(p); return acc; }, {});
};

exports.updatePermission = async (id, body) => {
  const update = pick(body, ['name', 'key', 'module', 'route', 'description', 'scope']);
  const p = await Permission.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true });
  if (!p) throw err('Permission not found', 404);
  return p;
};

exports.deletePermission = async (id) => {
  const role = await Role.findOne({ permissionIds: id });
  if (role) throw err(`Cannot delete permission. It is assigned to the '${role.name}' role.`, 400);
  const p = await Permission.findByIdAndDelete(id);
  if (!p) throw err('Permission not found', 404);
  return p;
};
