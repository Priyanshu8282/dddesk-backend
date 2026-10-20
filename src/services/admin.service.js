const mongoose = require('mongoose');
const Admin   = require('../models/admin.model');
const Library = require('../models/library.model');
const Role    = require('../models/role.model');
const Branch  = require('../models/branch.model');
const Notification = require('../models/notification.model');
const pick    = require('../utils/pick');
const escapeRegex = require('../utils/escapeRegex');
const audit   = require('../utils/audit');
const { normalizeMobile } = require('../utils/mobile');

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const idOf = (v) => String(v && v._id ? v._id : v);
const isOwnerOrSA = (req) => req.userType === 'admin' || req.userType === 'superadmin';

// Role names that identify platform/owner level roles - never assignable to staff
const PRIVILEGED_ROLE_NAMES = ['super admin', 'admin'];

// Fields a user may change on their OWN account (no role / status / tenant fields)
const SELF_FIELDS = ['name', 'mobile', 'alternativeMobileNumber', 'address', 'city', 'state', 'country', 'pincode'];
// Fields an owner / permitted staff may change on a staff member
const STAFF_FIELDS = [...SELF_FIELDS, 'email', 'joiningDate'];
// Library fields mirrored from the owner account
const OWNER_LIBRARY_FIELDS = ['ownerName', 'alternativeMobileNumber', 'address', 'city', 'state', 'country', 'pincode', 'website', 'gstNumber'];

const fileList = (files) => (Array.isArray(files) ? files : []);
const normPath = (p) => (p ? String(p).replace(/\\/g, '/') : p);

const parseDocuments = (documentNames, files, existing = []) => {
  if (!documentNames) return undefined;
  let names;
  try { names = typeof documentNames === 'string' ? JSON.parse(documentNames) : documentNames; } catch (_) { return undefined; }
  if (!Array.isArray(names)) return undefined;
  return names.slice(0, 20).map((docName, i) => {
    const docFile = fileList(files).find((f) => f.fieldname === `docFile_${i}`);
    if (docFile) return { name: String(docName), files: [normPath(docFile.path)] };
    return existing.find((d) => d.name === docName) || { name: String(docName), files: [] };
  });
};

// ── Tenant scoping ────────────────────────────────────────────────────────────

// Mongo filter selecting only accounts the requester may see/touch
const scopeFilter = (req) => {
  if (req.userType === 'superadmin') return {};
  return { libraryId: req.libraryId };
};

const loadTarget = async (req, id, { populate = false } = {}) => {
  let q = Admin.findOne({ _id: id, ...scopeFilter(req) });
  if (populate) q = q.populate('roleId', 'name libraryId permissionIds').populate('libraryId');
  const target = await q;
  if (!target) throw err('User not found', 404);
  // Only a superadmin may ever touch superadmin accounts
  if (target.userType === 'superadmin' && req.userType !== 'superadmin') throw err('User not found', 404);
  return target;
};

// A role is assignable when it is a system role or belongs to the tenant, and is not an owner/platform role.
// Non-owner callers can only hand out roles whose permissions they hold themselves (no self-escalation).
const resolveAssignableRole = async (req, roleId, tenant) => {
  const role = await Role.findOne({ _id: roleId, status: true }).populate('permissionIds', 'key');
  if (!role) throw err('Role not found', 404);
  if (role.libraryId && idOf(role.libraryId) !== idOf(tenant)) throw err('Role not found', 404);
  if (!role.libraryId && req.userType !== 'superadmin') throw err('Role not found', 404); // platform templates are not for libraries
  if (req.userType !== 'superadmin' && PRIVILEGED_ROLE_NAMES.includes(String(role.name).toLowerCase())) {
    throw err('This role cannot be assigned to staff', 403);
  }
  if (req.userType === 'staff') {
    const mine = new Set(req.permissions || []);
    if (!role.permissionIds.every((p) => mine.has(p.key))) {
      throw err('You cannot assign a role with permissions you do not have', 403);
    }
  }
  return role;
};

const defaultStaffRole = async (tenant) => {
  let role = await Role.findOne({ name: 'Staff', libraryId: tenant, status: true });
  if (!role) { await require('./libraryRoles.service').provisionDefaultRoles(tenant); role = await Role.findOne({ name: 'Staff', libraryId: tenant, status: true }); }
  if (!role) role = await Role.findOne({ name: 'Staff', libraryId: null, status: true });
  if (!role) throw err("System Error: 'Staff' role is missing.", 500);
  return role;
};

// Branch ids must belong to the tenant
const validateBranchIds = async (branchIds, tenant) => {
  if (!branchIds) return undefined;
  const ids = [...new Set(branchIds.map(String))];
  if (!ids.length) return [];
  const count = await Branch.countDocuments({ _id: { $in: ids }, libraryId: tenant, isDeleted: false });
  if (count !== ids.length) throw err('One or more branches do not belong to this library', 400);
  return ids;
};

// A mobile number may be used by one person of a library only
const assertMobileFree = async (mobile, tenant, exceptId = null) => {
  if (!mobile) return;
  const filter = { mobile, libraryId: tenant, isDeleted: false };
  if (exceptId) filter._id = { $ne: exceptId };
  if (await Admin.findOne(filter)) throw err('This mobile number is already used by someone in your team', 400);
};

// ── Staff / Employee ──────────────────────────────────────────────────────────

exports.createStaff = async (req) => {
  const { body, files } = req;
  const tenant = req.userType === 'superadmin' ? (body.libraryId || req.libraryId) : req.libraryId;
  if (!tenant) throw err('Library is required', 400);
  const library = await Library.findOne({ _id: tenant, isDeleted: false });
  if (!library) throw err('Library not found', 404);

  const email = String(body.email).toLowerCase();
  if (await Admin.findOne({ email })) throw err('Email already exists', 400);
  await assertMobileFree(normalizeMobile(body.mobile), tenant);

  // Plan limit (spec 12 / platform plan maxStaff)
  const maxStaff = library.planLimits?.maxStaff;
  if (typeof maxStaff === 'number' && maxStaff > 0) {
    const current = await Admin.countDocuments({ libraryId: tenant, userType: 'staff' });
    if (current >= maxStaff) {
      throw err(`Staff limit reached for your plan (${maxStaff}). Upgrade your plan to add more staff.`, 403);
    }
  }

  const roleId = body.roleId || (await defaultStaffRole(tenant))._id;
  const role = await resolveAssignableRole(req, roleId, tenant);
  const branchIds = await validateBranchIds(body.branchIds, tenant);

  const pf = fileList(files).find((f) => f.fieldname === 'profileImage');
  const staff = await Admin.create({
    ...pick(body, STAFF_FIELDS.filter((k) => k !== 'email')),
    mobile: normalizeMobile(body.mobile),
    email,
    password: body.password,       // hashed by pre-save hook
    userType: 'staff',
    roleId: role._id,
    libraryId: tenant,
    branchIds: branchIds || [],
    documents: parseDocuments(body.documentNames, files) || [],
    profileImage: pf ? normPath(pf.path) : '',
    createdBy: req.user._id,
  }).catch((e) => { if (e && e.code === 11000) throw err('Email already exists', 400); throw e; });

  await audit(req, 'staff.create', 'Admin', staff._id, { email, roleId: role._id, roleName: role.name, branchIds });
  return Admin.findById(staff._id).populate('roleId', 'name').populate('branchIds', 'name');
};

// Public self registration and superadmin library creation. Atomic via compensating delete
// (MongoDB transactions need a replica set which is not guaranteed on the target deployments).
exports.createLibraryWithAdmin = async (input, files, requestingUser) => {
  const email = String(input.email).toLowerCase();
  const mobile = normalizeMobile(input.mobile);

  if (await Admin.findOne({ email })) throw err('An account with this email already exists', 409);
  if (await Library.findOne({ mobile, isDeleted: false })) throw err('A library with this mobile number already exists', 409);

  // Role is always resolved server side - never trusted from the client
  const adminRole = await Role.findOne({ name: 'Admin', libraryId: null });
  if (!adminRole) throw err("System Error: 'Admin' role missing.", 500);

  let profileImage = '', logo = '', photos = [];
  const list = fileList(files);
  const pf = list.find((f) => f.fieldname === 'profileImage');
  const lf = list.find((f) => f.fieldname === 'logo');
  const ph = list.filter((f) => f.fieldname === 'photos');
  if (pf) profileImage = normPath(pf.path);
  if (lf) logo = normPath(lf.path);
  if (ph.length) photos = ph.map((f) => normPath(f.path));

  const bySuper = !!requestingUser && requestingUser.userType === 'superadmin';

  const library = new Library({
    name: input.name, ownerName: input.ownerName, mobile,
    alternativeMobileNumber: input.alternativeMobileNumber, email,
    roleId: adminRole._id,
    address: input.address, city: input.city, state: input.state,
    country: input.country || 'India', pincode: input.pincode,
    description: input.description, website: input.website, gstNumber: input.gstNumber,
    seatCapacity: input.seatCapacity, facilities: input.facilities,
    logo, photos,
    workingHours: input.workingHours,
    // Public registration is always pending; a superadmin-created library is active
    status: bySuper ? 'active' : 'pending',
    createdBy: bySuper ? 'SUPER_ADMIN' : 'SELF',
    createdById: bySuper ? requestingUser._id : null,
  });
  await library.save();

  let admin;
  try {
    admin = await Admin.create({
      name: input.ownerName, email, password: input.password,
      userType: 'admin', roleId: adminRole._id, libraryId: library._id,
      mobile, alternativeMobileNumber: input.alternativeMobileNumber,
      address: input.address, city: input.city, state: input.state,
      country: input.country || 'India', pincode: input.pincode,
      profileImage, createdBy: bySuper ? requestingUser._id : null,
    });
  } catch (e) {
    await Library.deleteOne({ _id: library._id }); // compensate: no orphan library
    throw e;
  }

  // the library's own copy of the basic roles (Staff, Receptionist, Accountant, Manager); never blocks sign-up
  try { await require('./libraryRoles.service').provisionDefaultRoles(library._id, admin._id); } catch (e) { console.error('default roles were not created:', e.message); }

  if (bySuper) {
    const { provisionLibrary } = require('./libraryProvision.service');
    const r = await provisionLibrary(library, { approvedBy: requestingUser._id });
    return { library: r.library, admin, onboarding: r.onboarding };
  }

  // Alert the platform owners (in-app + the e-mails set in Platform Settings; honours the on/off switch)
  require('./platformAlerts.service').notify('newRegistration', {
    message: `${library.name}${library.city ? ' (' + library.city + ')' : ''} has requested approval. Owner: ${admin.name}, ${admin.email}.`,
    libraryId: library._id, dedupeKey: String(library._id), data: { libraryId: library._id },
  });

  return { library, admin };
};

exports.listStaff = async (req, query = req.query) => {
  const { page = 1, limit = 10, search = '', userType = 'staff', status = '', libraryId = '', roleId = '', branchId = '', sort = 'newest' } = query;
  const filter = { isDeleted: false };

  if (req.userType === 'superadmin') {
    if (userType !== 'all') filter.userType = ['staff', 'admin', 'superadmin'].includes(userType) ? userType : 'staff';
    if (libraryId && mongoose.isValidObjectId(libraryId)) filter.libraryId = libraryId;
  } else {
    // tenant users only ever see staff of their own library (owners themselves are listed with userType=all)
    filter.libraryId = req.libraryId;
    filter.userType = userType === 'all' ? { $in: ['staff', 'admin'] } : 'staff';
  }

  if (status === 'active') filter.status = true;
  else if (status === 'inactive') filter.status = false;

  if (roleId && mongoose.isValidObjectId(roleId)) filter.roleId = roleId;
  // branchId=none -> staff who work in every branch (no branch list); otherwise staff allowed in that branch
  if (branchId === 'none') filter.branchIds = { $size: 0 };
  else if (branchId && mongoose.isValidObjectId(branchId)) filter.branchIds = branchId;

  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: re }, { email: re }, { mobile: re }];
  }

  const SORTS = {
    newest: { createdAt: -1 }, oldest: { createdAt: 1 }, name: { name: 1, _id: 1 },
    lastLogin: { lastLogin: -1, createdAt: -1 }, joining: { joiningDate: -1, createdAt: -1 },
  };
  const sortBy = SORTS[sort] || SORTS.newest;

  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
  const [data, total] = await Promise.all([
    Admin.find(filter).populate('roleId', 'name').populate('libraryId', 'name').populate('branchIds', 'name')
      .sort(sortBy).skip((p - 1) * l).limit(l),
    Admin.countDocuments(filter),
  ]);

  const summaryBase = { isDeleted: false, userType: filter.userType };
  if (filter.libraryId) summaryBase.libraryId = filter.libraryId;
  const [totalCount, activeCount, inactiveCount, rolesUsed] = await Promise.all([
    Admin.countDocuments(summaryBase),
    Admin.countDocuments({ ...summaryBase, status: true }),
    Admin.countDocuments({ ...summaryBase, status: false }),
    Admin.distinct('roleId', summaryBase),
  ]);

  return { data, total, page: p, limit: l, totalPages: Math.ceil(total / l), summary: { total: totalCount, active: activeCount, inactive: inactiveCount, rolesInUse: rolesUsed.filter(Boolean).length } };
};

exports.getAdminById = async (req, id) => {
  const target = await loadTarget(req, id);
  // staff may read themselves; reading others requires a staff-view permission
  if (req.userType === 'staff' && idOf(target._id) !== idOf(req.user._id)
      && !['staff.view', 'VIEW_ADMINS'].some((k) => (req.permissions || []).includes(k))) {
    throw err('You do not have permission to perform this action', 403);
  }
  return Admin.findById(target._id).populate('roleId', 'name').populate('libraryId').populate('branchIds', 'name');
};

const rejectUnauthorizedEdit = (req, target) => {
  const isSelf = idOf(target._id) === idOf(req.user._id);
  if (isSelf) return { isSelf };
  if (req.userType === 'superadmin') return { isSelf };
  if (target.userType !== 'staff') throw err('You cannot modify this account', 403);
  if (req.userType === 'staff') {
    const mine = req.permissions || [];
    if (!['staff.edit', 'UPDATE_ADMIN'].some((k) => mine.includes(k))) throw err('You do not have permission to perform this action', 403);
  }
  return { isSelf };
};

exports.updateAdmin = async (req, id) => {
  const { body, files } = req;
  const target = await loadTarget(req, id, { populate: true });
  const { isSelf } = rejectUnauthorizedEdit(req, target);
  const tenant = target.libraryId?._id || target.libraryId;

  const update = pick(body, isSelf ? SELF_FIELDS : STAFF_FIELDS);
  if (update.mobile) update.mobile = normalizeMobile(update.mobile);
  if (update.alternativeMobileNumber) update.alternativeMobileNumber = normalizeMobile(update.alternativeMobileNumber);
  if (update.mobile && update.mobile !== target.mobile && tenant) await assertMobileFree(update.mobile, tenant, target._id);

  if (update.email) {
    update.email = String(update.email).toLowerCase();
    if (update.email !== target.email && await Admin.findOne({ email: update.email, _id: { $ne: target._id } })) {
      throw err('Email already exists', 400);
    }
  }

  // Role / branch / status: only on others, never self-service (no self-escalation)
  let roleChange = null;
  if (!isSelf) {
    if (body.roleId && idOf(body.roleId) !== idOf(target.roleId)) {
      if (target.userType !== 'staff') throw err('The role of this account cannot be changed', 403);
      const role = await resolveAssignableRole(req, body.roleId, tenant);
      roleChange = { from: target.roleId?._id || null, fromName: target.roleId?.name, to: role._id, toName: role.name };
      update.roleId = role._id;
    }
    if (body.branchIds !== undefined) update.branchIds = await validateBranchIds(body.branchIds, tenant);
    if (body.status !== undefined && target.userType === 'staff') update.status = !!body.status;
  }

  const docs = parseDocuments(body.documentNames, files, target.documents || []);
  if (docs) update.documents = docs;

  const pf = fileList(files).find((f) => f.fieldname === 'profileImage');
  if (pf) update.profileImage = normPath(pf.path);
  else if (['REMOVE_IMAGE', 'null'].includes(body.profileImage)) update.profileImage = null;

  update.updatedBy = req.user._id;
  Object.assign(target, update);          // target is a fresh doc loaded above; allow-listed keys only
  await target.save();

  // Owner editing their own account mirrors contact fields to the library record
  if (isSelf && target.userType === 'admin' && tenant) {
    const libUpdate = pick(body, OWNER_LIBRARY_FIELDS);
    if (update.name || body.ownerName) libUpdate.ownerName = body.ownerName || update.name;
    if (update.alternativeMobileNumber) libUpdate.alternativeMobileNumber = update.alternativeMobileNumber;
    if (Object.keys(libUpdate).length) await Library.updateOne({ _id: tenant }, { $set: libUpdate }, { runValidators: true });
  }

  await audit(req, 'staff.update', 'Admin', target._id, { fields: Object.keys(update).filter((k) => k !== 'updatedBy'), self: isSelf });
  if (roleChange) await audit(req, 'staff.role_change', 'Admin', target._id, roleChange);

  return Admin.findById(target._id).populate('roleId', 'name').populate('libraryId').populate('branchIds', 'name');
};

exports.updateStatus = async (req, id, status) => {
  const target = await loadTarget(req, id);
  if (idOf(target._id) === idOf(req.user._id)) throw err('You cannot change your own status', 400);
  if (target.userType !== 'staff' && req.userType !== 'superadmin') throw err('You cannot modify this account', 403);
  if (req.userType === 'staff') {
    const mine = req.permissions || [];
    if (!['staff.edit', 'UPDATE_ADMIN'].some((k) => mine.includes(k))) throw err('You do not have permission to perform this action', 403);
  }
  // Library status is never touched here: it changes only through superadmin approve/reject/suspend/reinstate
  target.status = !!status;
  target.updatedBy = req.user._id;
  await target.save();
  await audit(req, 'staff.status', 'Admin', target._id, { status: target.status });
  return Admin.findById(target._id).populate('roleId', 'name').populate('libraryId');
};

exports.softDelete = async (req, id) => {
  const target = await loadTarget(req, id);
  if (idOf(target._id) === idOf(req.user._id)) throw err('Cannot delete your own account', 400);
  if (target.userType !== 'staff' && req.userType !== 'superadmin') throw err('You cannot delete this account', 403);
  if (target.userType === 'superadmin') throw err('Cannot delete a superadmin account', 403);
  if (req.userType === 'staff') {
    const mine = req.permissions || [];
    if (!['staff.delete', 'DELETE_ADMIN'].some((k) => mine.includes(k))) throw err('You do not have permission to perform this action', 403);
  }
  target.isDeleted = true;
  target.status = false;
  target.updatedBy = req.user._id;
  await target.save();
  // Free up branch manager slots held by this person
  await Branch.updateMany({ managerId: target._id }, { $set: { managerId: null } });
  await audit(req, 'staff.delete', 'Admin', target._id, { email: target.email, userType: target.userType });
};

// Owner (or superadmin) sets a new password for a staff member
exports.resetPasswordByOwner = async (req, id, newPassword) => {
  const target = await loadTarget(req, id);
  if (target.userType !== 'staff' && req.userType !== 'superadmin') throw err('You can only reset passwords of your staff', 403);
  if (target.userType === 'superadmin' && req.userType !== 'superadmin') throw err('User not found', 404);
  target.password = newPassword;   // save() -> pre-save hook hashes
  target.tokensValidAfter = new Date(); // end the staff member's existing sessions
  target.updatedBy = req.user._id;
  await target.save();
  await audit(req, 'staff.password_reset', 'Admin', target._id, { email: target.email });
};
