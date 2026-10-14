const mongoose = require('mongoose');
const Role = require('../models/role.model');
const Permission = require('../models/permission.model');
const SidebarMenu = require('../models/sidebar.model');
const Admin = require('../models/admin.model');
const Library = require('../models/library.model');
const pick = require('../utils/pick');
const audit = require('../utils/audit');
const { PLATFORM_ONLY_KEYS } = require('../seed/permissionCatalog');

const err = (msg, status) => Object.assign(new Error(msg), { status });
const idOf = (v) => String(v && v._id ? v._id : v);
const isSA = (req) => req.userType === 'superadmin';

// Roles non-superadmins must never see or assign
const HIDDEN_FOR_TENANTS = ['Super Admin', 'Admin'];

const populateRole = (q) => q.populate('permissionIds').populate('sidebarMenuIds');

// Visible roles: system roles + the tenant's own roles
const visibleFilter = (req) => {
  if (isSA(req)) return {};
  return {
    $or: [{ libraryId: null }, { libraryId: req.libraryId }],
    name: { $nin: HIDDEN_FOR_TENANTS },
  };
};

// Validates permission ids exist; tenants may not grant platform-only permissions
const validatePermissions = async (req, ids) => {
  if (!ids) return undefined;
  const unique = [...new Set(ids.map(String))];
  const perms = await Permission.find({ _id: { $in: unique } }).select('key scope');
  if (perms.length !== unique.length) throw err('One or more permissions do not exist', 400);
  if (!isSA(req) && perms.some((p) => p.scope === 'platform' || PLATFORM_ONLY_KEYS.includes(p.key))) {
    throw err('Platform-level permissions cannot be granted to library roles', 403);
  }
  return unique;
};

const validateMenus = async (ids) => {
  if (!ids) return undefined;
  const unique = [...new Set(ids.map(String))];
  const count = await SidebarMenu.countDocuments({ _id: { $in: unique } });
  if (count !== unique.length) throw err('One or more menu items do not exist', 400);
  return unique;
};

exports.createRole = async (req) => {
  const body = pick(req.body, ['name', 'description', 'permissionIds', 'sidebarMenuIds', 'status']);
  // Tenant roles belong to the caller's library; only superadmin may create system roles (no libraryId) or target a tenant
  let libraryId = req.libraryId;
  if (isSA(req)) libraryId = req.body.libraryId || null;
  if (!isSA(req) && HIDDEN_FOR_TENANTS.includes(body.name)) throw err('This role name is reserved', 400);

  const role = await Role.create({
    ...body,
    permissionIds: await validatePermissions(req, body.permissionIds),
    sidebarMenuIds: await validateMenus(body.sidebarMenuIds),
    libraryId,
    isDefault: false,
    createdBy: req.user._id,
  });
  await audit(req, 'role.create', 'Role', role._id, { name: role.name, permissions: role.permissionIds.length });
  return populateRole(Role.findById(role._id));
};

exports.listRoles = async (req) => {
  const filter = visibleFilter(req);
  if (isSA(req) && req.query?.libraryId && mongoose.isValidObjectId(req.query.libraryId)) {
    filter.$or = [{ libraryId: null }, { libraryId: req.query.libraryId }];
  }
  return populateRole(Role.find(filter).sort({ isDefault: -1, name: 1 }));
};

exports.getRoleById = async (req, id) => {
  const role = await populateRole(Role.findOne({ _id: id, ...visibleFilter(req) }));
  if (!role) throw err('Role not found', 404);
  return role;
};

// Loads a role the caller may modify
const loadModifiable = async (req, id) => {
  const role = await Role.findById(id);
  if (!role) throw err('Role not found', 404);
  if (!isSA(req)) {
    if (!role.libraryId || idOf(role.libraryId) !== idOf(req.libraryId)) {
      // system roles are visible but read-only; other tenants' roles do not exist for us
      if (!role.libraryId && !HIDDEN_FOR_TENANTS.includes(role.name)) throw err('System roles can only be modified by a super admin', 403);
      throw err('Role not found', 404);
    }
    if (role.isDefault) throw err('Cannot modify default system roles', 403);
  }
  return role;
};

exports.updateRole = async (req, id) => {
  const role = await loadModifiable(req, id);
  const body = pick(req.body, ['name', 'description', 'permissionIds', 'sidebarMenuIds', 'status']);
  if (!isSA(req) && body.name && HIDDEN_FOR_TENANTS.includes(body.name)) throw err('This role name is reserved', 400);
  const before = role.permissionIds.map(String).sort();

  if (body.name !== undefined) role.name = body.name;
  if (body.description !== undefined) role.description = body.description;
  if (body.status !== undefined) role.status = body.status;
  if (body.permissionIds !== undefined) role.permissionIds = await validatePermissions(req, body.permissionIds);
  if (body.sidebarMenuIds !== undefined) role.sidebarMenuIds = await validateMenus(body.sidebarMenuIds);
  await role.save();

  const after = role.permissionIds.map(String).sort();
  await audit(req, 'role.update', 'Role', role._id, {
    name: role.name, fields: Object.keys(body),
    permissionsChanged: JSON.stringify(before) !== JSON.stringify(after),
  });
  return populateRole(Role.findById(role._id));
};

exports.deleteRole = async (req, id) => {
  const role = await loadModifiable(req, id);
  if (role.isDefault) throw err('Cannot delete default system roles', 400);

  const [adminCount, libCount] = await Promise.all([
    Admin.countDocuments({ roleId: role._id, isDeleted: false }),
    Library.countDocuments({ roleId: role._id, isDeleted: false }),
  ]);
  if (adminCount > 0 || libCount > 0) {
    const deps = [];
    if (adminCount > 0) deps.push(`${adminCount} Admin/Staff members`);
    if (libCount > 0) deps.push(`${libCount} Library accounts`);
    throw err(`Cannot delete role. It is assigned to: ${deps.join(', ')}.`, 400);
  }
  await Role.deleteOne({ _id: role._id });
  await audit(req, 'role.delete', 'Role', role._id, { name: role.name });
};
