/**
 * Platform-wide user management for the super admin: library owners, staff, super admins and students.
 * Owners/staff/super admins live in the Admin collection, students in their own collection.
 * Built for a distant database: the list needs 4 round trips, all in parallel.
 */
const mongoose = require('mongoose');
const Admin = require('../models/admin.model');
const Student = require('../models/student.model');
const Library = require('../models/library.model');
const Role = require('../models/role.model');
const AuditLog = require('../models/auditLog.model');
const escapeRegex = require('../utils/escapeRegex');
const audit = require('../utils/audit');
const { normalizeMobile } = require('../utils/mobile');
const { invalidateAuthCache } = require('../middlewares/auth.middleware');

const err = (msg, status) => Object.assign(new Error(msg), { status });
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const TYPE_OF = { admin: 'owner', staff: 'staff', superadmin: 'superadmin' };
const ADMIN_TYPE_OF = { owner: 'admin', staff: 'staff', superadmin: 'superadmin' };
const SORTS = {
  newest: { createdAt: -1, _id: -1 }, oldest: { createdAt: 1, _id: 1 },
  name_asc: { name: 1, _id: 1 }, name_desc: { name: -1, _id: -1 }, last_login: { lastLogin: -1, _id: -1 },
};

const libOf = (l) => (l ? { _id: l._id, name: l.name, code: l.libraryCode || null, status: l.status } : null);
const shapeAdmin = (a) => ({
  _id: a._id, type: TYPE_OF[a.userType] || 'staff', name: a.name, email: a.email, mobile: a.mobile || null,
  status: a.status ? 'active' : 'disabled', library: libOf(a.libraryId && a.libraryId._id ? a.libraryId : null),
  role: a.roleId && a.roleId.name ? a.roleId.name : null, lastLogin: a.lastLogin || null, createdAt: a.createdAt,
  profileImage: a.profileImage || null,
});
const shapeStudent = (s) => ({
  _id: s._id, type: 'student', name: s.name, email: s.email || null, mobile: s.mobile || null,
  status: s.status === 'active' ? 'active' : 'disabled', library: libOf(s.libraryId && s.libraryId._id ? s.libraryId : null),
  role: null, lastLogin: s.lastLogin || null, createdAt: s.createdAt, profileImage: s.profileImage || null,
});

const searchRegex = (q) => new RegExp(escapeRegex(String(q).trim()), 'i');

/** Admin-collection filter for a given type/status/library/search (aggregate does not get the soft-delete hook) */
const adminFilter = (q) => {
  const f = { isDeleted: { $ne: true } };
  const t = q.type && q.type !== 'all' ? ADMIN_TYPE_OF[q.type] : null;
  // accounts saved before userType existed behave as staff everywhere else, so they count as staff here too
  if (t === 'staff') f.userType = { $in: ['staff', null] }; else if (t) f.userType = t;
  if (q.status === 'active') f.status = true; else if (q.status === 'disabled') f.status = false;
  if (q.libraryId && mongoose.isValidObjectId(q.libraryId)) f.libraryId = oid(q.libraryId);
  if (q.q && String(q.q).trim()) {
    const re = searchRegex(q.q);
    f.$or = [{ name: re }, { email: re }, { mobile: re }];
  }
  return f;
};

exports.list = async (q = {}) => {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 15));
  const sort = SORTS[q.sort] || SORTS.newest;
  const isStudents = q.type === 'student';

  // headline counts do not depend on the filters, so the tabs always show the real totals
  const countsPromise = Promise.all([
    Admin.aggregate([{ $match: { isDeleted: { $ne: true } } }, { $group: { _id: { t: '$userType', s: '$status' }, n: { $sum: 1 } } }]),
    Student.aggregate([{ $match: { isDeleted: { $ne: true } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);

  let rows, total;
  if (isStudents) {
    const f = { isDeleted: { $ne: true } };
    if (q.status === 'active') f.status = 'active'; else if (q.status === 'disabled') f.status = { $in: ['inactive', 'suspended'] };
    if (q.libraryId && mongoose.isValidObjectId(q.libraryId)) f.libraryId = oid(q.libraryId);
    if (q.q && String(q.q).trim()) { const re = searchRegex(q.q); f.$or = [{ name: re }, { email: re }, { mobile: re }]; }
    const [r, t] = await Promise.all([
      Student.find(f).sort(sort).skip((page - 1) * limit).limit(limit).populate('libraryId', 'name libraryCode status').lean(),
      Student.countDocuments(f),
    ]);
    rows = r.map(shapeStudent); total = t;
  } else {
    const f = adminFilter(q);
    const [r, t] = await Promise.all([
      Admin.find(f).sort(sort).skip((page - 1) * limit).limit(limit)
        .select('name email mobile userType status lastLogin createdAt profileImage libraryId roleId')
        .populate('libraryId', 'name libraryCode status').populate('roleId', 'name').lean(),
      Admin.countDocuments(f),
    ]);
    rows = r.map(shapeAdmin); total = t;
  }

  const [adminAgg, studentAgg] = await countsPromise;
  const c = { owners: 0, staff: 0, superadmins: 0, students: 0, disabled: 0, total: 0 };
  adminAgg.forEach((x) => {
    const key = x._id.t === 'admin' ? 'owners' : x._id.t === 'superadmin' ? 'superadmins' : 'staff';
    c[key] += x.n; if (!x._id.s) c.disabled += x.n;
  });
  studentAgg.forEach((x) => { c.students += x.n; if (x._id !== 'active') c.disabled += x.n; });
  c.total = c.owners + c.staff + c.superadmins + c.students;

  return { data: rows, total, page, limit, totalPages: Math.ceil(total / limit), counts: c };
};

exports.get = async (id, type) => {
  if (type === 'student') {
    const s = await Student.findOne({ _id: id, isDeleted: { $ne: true } }).populate('libraryId', 'name libraryCode status slug').populate('planId', 'name').lean();
    if (!s) throw err('User not found', 404);
    const logs = await AuditLog.find({ userId: s._id }).sort({ createdAt: -1 }).limit(10).select('action createdAt ipAddress').lean();
    return { ...shapeStudent(s), details: { plan: s.planId?.name || null, planStatus: s.planStatus || null, expiryDate: s.expiryDate || null, seatNumber: s.seatNumber || null, registrationNumber: s.registrationNumber || null, address: s.address || null }, activity: logs };
  }
  const a = await Admin.findOne({ _id: id, isDeleted: { $ne: true } })
    .select('-password').populate('libraryId', 'name libraryCode status slug subscriptionPlan subscriptionExpiry').populate({ path: 'roleId', select: 'name permissionIds', populate: { path: 'permissionIds', select: 'key' } }).lean();
  if (!a) throw err('User not found', 404);
  const [logs, branches] = await Promise.all([
    AuditLog.find({ userId: a._id }).sort({ createdAt: -1 }).limit(10).select('action resource createdAt ipAddress').lean(),
    a.branchIds?.length ? mongoose.model('Branch').find({ _id: { $in: a.branchIds } }).select('name').lean() : [],
  ]);
  return {
    ...shapeAdmin(a),
    details: {
      address: a.address || null, city: a.city || null, state: a.state || null, alternativeMobileNumber: a.alternativeMobileNumber || null,
      joiningDate: a.joiningDate || null, permissionCount: a.roleId?.permissionIds?.length || 0,
      branches: branches.map((b) => b.name),
      subscriptionPlan: a.libraryId?.subscriptionPlan || null, subscriptionExpiry: a.libraryId?.subscriptionExpiry || null,
    },
    activity: logs,
  };
};

const activeSuperAdmins = (exceptId) => Admin.countDocuments({ userType: 'superadmin', status: true, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });

const loadAdmin = async (id) => {
  const a = await Admin.findOne({ _id: id, isDeleted: { $ne: true } }).select('+password');
  if (!a) throw err('User not found', 404);
  return a;
};
const notSelf = (req, id, msg) => { if (String(req.user._id) === String(id)) throw err(msg, 400); };

exports.create = async (req, { name, email, mobile, password }) => {
  const mob = normalizeMobile(mobile);
  const mail = String(email).trim().toLowerCase();
  if (await Admin.findOne({ email: mail }).select('_id').lean()) throw err('An account with this email already exists', 409);
  if (await Admin.findOne({ mobile: mob, userType: 'superadmin' }).select('_id').lean()) throw err('A super admin with this mobile number already exists', 409);
  const role = await Role.findOne({ name: 'Super Admin', $or: [{ libraryId: null }, { libraryId: { $exists: false } }] }).select('_id').lean();
  if (!role) throw err('The Super Admin role is missing. Run the permission sync first.', 500);
  const user = await Admin.create({ name: String(name).trim(), email: mail, mobile: mob, password, userType: 'superadmin', roleId: role._id, status: true, createdBy: req.user._id });
  await audit(req, 'platform_user.create', 'Admin', user._id, { type: 'superadmin', email: mail });
  return shapeAdmin(user.toObject());
};

exports.update = async (req, id, body) => {
  const a = await loadAdmin(id);
  const set = {};
  if (body.name !== undefined) set.name = String(body.name).trim();
  if (body.email !== undefined) {
    const mail = String(body.email).trim().toLowerCase();
    if (mail !== a.email && await Admin.findOne({ email: mail, _id: { $ne: a._id } }).select('_id').lean()) throw err('An account with this email already exists', 409);
    set.email = mail;
  }
  if (body.mobile !== undefined) set.mobile = normalizeMobile(body.mobile);
  if (!Object.keys(set).length) throw err('Nothing to update', 400);
  set.updatedBy = req.user._id;
  await Admin.updateOne({ _id: a._id }, { $set: set });
  // an owner's contact details are mirrored on the library record
  if (a.userType === 'admin' && a.libraryId && (set.email || set.mobile)) {
    const lib = {}; if (set.email) lib.email = set.email; if (set.mobile) lib.mobile = set.mobile;
    await Library.updateOne({ _id: a.libraryId }, { $set: lib }).catch(() => {});
  }
  invalidateAuthCache(a._id);
  await audit(req, 'platform_user.update', 'Admin', a._id, { fields: Object.keys(set).filter((k) => k !== 'updatedBy') });
  return exports.get(a._id, 'admin');
};

exports.setStatus = async (req, id, { type, active }) => {
  if (type === 'student') {
    const s = await Student.findOneAndUpdate({ _id: id, isDeleted: { $ne: true } }, { $set: { status: active ? 'active' : 'inactive', ...(active ? {} : { tokensValidAfter: new Date() }) } }, { new: true });
    if (!s) throw err('User not found', 404);
    invalidateAuthCache(s._id);
    await audit(req, active ? 'platform_user.enable' : 'platform_user.disable', 'Student', s._id, {});
    return { _id: s._id, status: active ? 'active' : 'disabled' };
  }
  const a = await loadAdmin(id);
  if (!active) {
    notSelf(req, a._id, 'You cannot disable your own account');
    if (a.userType === 'superadmin' && (await activeSuperAdmins(a._id)) === 0) throw err('This is the last active super admin and cannot be disabled', 400);
  }
  await Admin.updateOne({ _id: a._id }, { $set: { status: !!active, updatedBy: req.user._id, ...(active ? {} : { tokensValidAfter: new Date() }) } });
  invalidateAuthCache(a._id);
  await audit(req, active ? 'platform_user.enable' : 'platform_user.disable', 'Admin', a._id, { userType: a.userType });
  return { _id: a._id, status: active ? 'active' : 'disabled' };
};

exports.resetPassword = async (req, id, newPassword) => {
  const a = await loadAdmin(id);
  notSelf(req, a._id, 'Use the Profile page to change your own password');
  a.password = newPassword; // hashed once by the model hook
  a.tokensValidAfter = new Date(); // every existing session ends
  a.otp = undefined; a.otpExpires = undefined; a.otpAttempts = 0;
  await a.save({ validateModifiedOnly: true });
  invalidateAuthCache(a._id);
  await audit(req, 'platform_user.password_reset', 'Admin', a._id, { userType: a.userType });
};

exports.archive = async (req, id) => {
  const a = await loadAdmin(id);
  notSelf(req, a._id, 'You cannot delete your own account');
  if (a.userType === 'admin') throw err('A library owner cannot be deleted on their own. Delete or suspend the library instead.', 400);
  if (a.userType === 'superadmin' && (await activeSuperAdmins(a._id)) === 0) throw err('This is the last active super admin and cannot be deleted', 400);
  await Admin.updateOne({ _id: a._id }, { $set: { isDeleted: true, status: false, tokensValidAfter: new Date(), updatedBy: req.user._id } });
  invalidateAuthCache(a._id);
  await audit(req, 'platform_user.delete', 'Admin', a._id, { userType: a.userType, email: a.email });
};

/** Libraries for the "filter by library" dropdown */
exports.libraryOptions = async () => Library.find({ isDeleted: false }).select('name libraryCode').sort({ name: 1 }).limit(500).lean();
