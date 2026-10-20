const mongoose = require('mongoose');
const Role = require('../models/role.model');
const Permission = require('../models/permission.model');
const SidebarMenu = require('../models/sidebar.model');
const Admin = require('../models/admin.model');
const Library = require('../models/library.model');
const pick = require('../utils/pick');
const audit = require('../utils/audit');
const { PLATFORM_ONLY_KEYS, ALIASES } = require('../seed/permissionCatalog');
const escapeRegex = require('../utils/escapeRegex');

const err = (msg, status) => Object.assign(new Error(msg), { status });
const idOf = (v) => String(v && v._id ? v._id : v);
const isSA = (req) => req.userType === 'superadmin';

// Roles non-superadmins must never see or assign
const HIDDEN_FOR_TENANTS = ['Super Admin', 'Admin'];

const populateRole = (q) => q.populate('permissionIds').populate('sidebarMenuIds');

// Visible roles: a library sees only its own roles (the basic ones are created for it when the library is created).
// Platform templates (libraryId = null) are for the super admin only.
const visibleFilter = (req) => {
  if (isSA(req)) return {};
  return { libraryId: req.libraryId, name: { $nin: HIDDEN_FOR_TENANTS } };
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

const validateMenus = async (req, ids) => {
  if (!ids) return undefined;
  const unique = [...new Set(ids.map(String))];
  const filter = { _id: { $in: unique } };
  // library roles may only use library-side menus
  if (!isSA(req)) filter.userType = { $nin: ['student', 'superadmin'] };
  const count = await SidebarMenu.countDocuments(filter);
  if (count !== unique.length) throw err('One or more menu items do not exist', 400);
  return unique;
};

// Role names are unique per library, ignoring upper/lower case
const nameRe = (name) => new RegExp('^' + escapeRegex(String(name).trim()) + '$', 'i');
const assertNameFree = async (name, libraryId, exceptId = null) => {
  const filter = { libraryId: libraryId || null, name: nameRe(name) };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await Role.findOne(filter, '_id')) throw err('A role with this name already exists', 400);
};

const dupMsg = (e) => { if (e && e.code === 11000) throw err('A role with this name already exists', 400); throw e; };

// How many (not deleted) staff accounts use each role, within the caller's library
const staffCounts = async (req, roleIds) => {
  if (!roleIds.length) return new Map();
  const match = { roleId: { $in: roleIds }, isDeleted: false, userType: 'staff' };
  if (!isSA(req)) match.libraryId = new mongoose.Types.ObjectId(String(req.libraryId));
  else if (req.query && req.query.libraryId && mongoose.isValidObjectId(req.query.libraryId)) match.libraryId = new mongoose.Types.ObjectId(String(req.query.libraryId));
  const rows = await Admin.aggregate([{ $match: match }, { $group: { _id: '$roleId', n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
};

const flags = (req, role) => {
  const isSystem = !role.libraryId;
  return { isSystem, canEdit: isSA(req) ? true : (!isSystem && !role.isDefault) };
};

exports.createRole = async (req) => {
  const body = pick(req.body, ['name', 'description', 'permissionIds', 'sidebarMenuIds', 'status']);
  // Tenant roles belong to the caller's library; only superadmin may create system roles (no libraryId) or target a tenant
  let libraryId = req.libraryId;
  if (isSA(req)) libraryId = req.body.libraryId || null;
  if (!isSA(req) && HIDDEN_FOR_TENANTS.includes(body.name)) throw err('This role name is reserved', 400);

  await assertNameFree(body.name, libraryId);
  const role = await Role.create({
    ...body,
    permissionIds: await validatePermissions(req, body.permissionIds),
    sidebarMenuIds: await validateMenus(req, body.sidebarMenuIds),
    libraryId,
    isDefault: false,
    createdBy: req.user._id,
  }).catch(dupMsg);
  await audit(req, 'role.create', 'Role', role._id, { name: role.name, permissions: role.permissionIds.length });
  return exports.getRoleById(req, role._id);
};

// Library roles with search / filters / sort / pagination. Without a page number every matching role is returned (role pickers).
exports.listRoles = async (req) => {
  const q = req.query || {};
  const filter = visibleFilter(req);
  if (isSA(req) && q.libraryId && mongoose.isValidObjectId(q.libraryId)) {
    filter.$or = [{ libraryId: null }, { libraryId: q.libraryId }];
  }
  const all = await Role.find(filter).populate('permissionIds', 'key module').populate('sidebarMenuIds', 'title').lean();
  const counts = await staffCounts(req, all.map((r) => r._id));

  const rows = all.map((r) => {
    const keys = (r.permissionIds || []).map((p) => p.key).filter(Boolean);
    return {
      _id: r._id, name: r.name, description: r.description || '', libraryId: r.libraryId || null, isDefault: !!r.isDefault, status: r.status !== false,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
      permissionIds: (r.permissionIds || []).map((p) => p._id),
      permissionKeys: keys,
      permissionCount: new Set(keys.map((k) => ALIASES[k] || k)).size,
      menuCount: (r.sidebarMenuIds || []).length,
      menuTitles: (r.sidebarMenuIds || []).map((m) => m.title),
      staffCount: counts.get(String(r._id)) || 0,
      ...flags(req, r),
    };
  });

  const summary = {
    total: rows.length,
    system: rows.filter((r) => r.isSystem).length,
    custom: rows.filter((r) => !r.isSystem).length,
    inUse: rows.filter((r) => r.staffCount > 0).length,
    staffAssigned: rows.reduce((n, r) => n + r.staffCount, 0),
  };

  let list = rows;
  const search = String(q.search || '').trim().toLowerCase();
  if (search) list = list.filter((r) => r.name.toLowerCase().includes(search) || r.description.toLowerCase().includes(search));
  if (q.type === 'system') list = list.filter((r) => r.isSystem);
  else if (q.type === 'custom') list = list.filter((r) => !r.isSystem);
  if (q.status === 'active') list = list.filter((r) => r.status);
  else if (q.status === 'inactive') list = list.filter((r) => !r.status);
  if (q.usage === 'used') list = list.filter((r) => r.staffCount > 0);
  else if (q.usage === 'unused') list = list.filter((r) => r.staffCount === 0);

  const byName = (x, y) => x.name.localeCompare(y.name);
  const SORTS = {
    name: byName,
    newest: (x, y) => new Date(y.createdAt) - new Date(x.createdAt) || byName(x, y),
    oldest: (x, y) => new Date(x.createdAt) - new Date(y.createdAt) || byName(x, y),
    staff: (x, y) => y.staffCount - x.staffCount || byName(x, y),
    permissions: (x, y) => y.permissionCount - x.permissionCount || byName(x, y),
  };
  list.sort(SORTS[q.sort] || ((x, y) => (Number(y.isSystem) - Number(x.isSystem)) || byName(x, y)));

  const total = list.length;
  const paged = q.page !== undefined;
  const limit = paged ? Math.min(100, Math.max(1, parseInt(q.limit, 10) || 10)) : Math.max(1, total);
  const page = paged ? Math.max(1, parseInt(q.page, 10) || 1) : 1;
  const data = paged ? list.slice((page - 1) * limit, page * limit) : list;
  return { data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), summary };
};

exports.getRoleById = async (req, id) => {
  const role = await populateRole(Role.findOne({ _id: id, ...visibleFilter(req) })).lean();
  if (!role) throw err('Role not found', 404);
  const counts = await staffCounts(req, [role._id]);
  return { ...role, staffCount: counts.get(String(role._id)) || 0, ...flags(req, role) };
};

// Copy of a role (same permissions and menus) owned by the caller's library
exports.duplicateRole = async (req, id) => {
  const src = await Role.findOne({ _id: id, ...visibleFilter(req) }).populate('permissionIds', 'scope key');
  if (!src) throw err('Role not found', 404);
  const libraryId = isSA(req) ? src.libraryId : req.libraryId;
  let name = src.name + ' (copy)';
  for (let n = 2; await Role.findOne({ libraryId: libraryId || null, name: nameRe(name) }, '_id'); n++) {
    name = src.name + ' (copy ' + n + ')';
    if (n > 50) throw err('Too many copies of this role already exist', 400);
  }
  const keepPerms = src.permissionIds.filter((p) => isSA(req) || !(p.scope === 'platform' || PLATFORM_ONLY_KEYS.includes(p.key)));
  const role = await Role.create({
    name, description: src.description, libraryId: libraryId || null,
    permissionIds: keepPerms.map((p) => p._id), sidebarMenuIds: src.sidebarMenuIds,
    isDefault: false, status: true, createdBy: req.user._id,
  }).catch(dupMsg);
  await audit(req, 'role.create', 'Role', role._id, { name: role.name, copiedFrom: src.name });
  return exports.getRoleById(req, role._id);
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
  if (body.name !== undefined && body.name.toLowerCase() !== String(role.name).toLowerCase()) await assertNameFree(body.name, role.libraryId, role._id);
  if (body.status === false && role.status !== false) {
    const used = (await staffCounts(req, [role._id])).get(String(role._id)) || 0;
    if (used > 0) throw err('This role is used by ' + used + ' staff member' + (used === 1 ? '' : 's') + '. Move them to another role before turning it off.', 400);
  }

  if (body.name !== undefined) role.name = body.name;
  if (body.description !== undefined) role.description = body.description;
  if (body.status !== undefined) role.status = body.status;
  if (body.permissionIds !== undefined) role.permissionIds = await validatePermissions(req, body.permissionIds);
  if (body.sidebarMenuIds !== undefined) role.sidebarMenuIds = await validateMenus(req, body.sidebarMenuIds);
  await role.save().catch(dupMsg);

  const after = role.permissionIds.map(String).sort();
  await audit(req, 'role.update', 'Role', role._id, {
    name: role.name, fields: Object.keys(body),
    permissionsChanged: JSON.stringify(before) !== JSON.stringify(after),
  });
  return exports.getRoleById(req, role._id);
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
