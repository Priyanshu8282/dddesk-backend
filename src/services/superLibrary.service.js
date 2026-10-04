const Library      = require('../modules/libraries/library.model');
const Admin        = require('../modules/admins/admin.model');
const Student      = require('../modules/students/student.model');
const PlatformPlan = require('../modules/platformPlans/platformPlan.model');
const AuditLog     = require('../modules/audit/auditLog.model');
const Role         = require('../modules/roles/role.model');

const err = (msg, status) => Object.assign(new Error(msg), { status });

const logAudit = async (action, resourceId, userId, metadata, ipAddress) => {
  try {
    await AuditLog.create({ action, resource: 'Library', resourceId, userId, userType: 'superadmin', metadata, ipAddress });
  } catch (_) {}
};

exports.listLibraries = async (query) => {
  const { search, status, page = 1, limit = 20 } = query;
  const filter = { isDeleted: false };
  if (status && status !== 'all') filter.status = status;
  if (search) {
    const re = new RegExp(search, 'i');
    filter.$or = [{ name: re },{ ownerName: re },{ mobile: re },{ email: re },{ city: re },{ state: re },{ libraryCode: re }];
  }
  const skip = (Number(page)-1) * Number(limit);
  const [libraries, total, totalAll, active, pending, suspended, rejected] = await Promise.all([
    Library.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).select('-password'),
    Library.countDocuments(filter),
    Library.countDocuments({ isDeleted: false }),
    Library.countDocuments({ isDeleted: false, status: 'active' }),
    Library.countDocuments({ isDeleted: false, status: 'pending' }),
    Library.countDocuments({ isDeleted: false, status: 'suspended' }),
    Library.countDocuments({ isDeleted: false, status: 'rejected' }),
  ]);
  return {
    libraries,
    pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total/Number(limit)) },
    counts: { total: totalAll, active, pending, suspended, rejected },
  };
};

exports.getLibraryById = async (id) => {
  const library = await Library.findOne({ _id: id, isDeleted: false }).select('-password');
  if (!library) throw err('Library not found', 404);
  const studentCount = await Student.countDocuments({ libraryId: id });
  return { ...library.toObject(), studentCount };
};

exports.approveLibrary = async (id, userId, ip) => {
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false, status: 'pending' }, { status: 'active', statusReason: null }, { new: true }
  ).select('-password');
  if (!lib) throw err('Library not found or not pending', 404);
  await logAudit('library_approved', lib._id, userId, { libraryName: lib.name }, ip);
  return lib;
};

exports.rejectLibrary = async (id, reason, userId, ip) => {
  if (!reason?.trim()) throw err('Rejection reason is required', 400);
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false }, { status: 'rejected', statusReason: reason }, { new: true }
  ).select('-password');
  if (!lib) throw err('Library not found', 404);
  await logAudit('library_rejected', lib._id, userId, { reason, libraryName: lib.name }, ip);
  return lib;
};

exports.suspendLibrary = async (id, reason, userId, ip) => {
  if (!reason?.trim()) throw err('Suspension reason is required', 400);
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false, status: 'active' }, { status: 'suspended', statusReason: reason }, { new: true }
  ).select('-password');
  if (!lib) throw err('Library not found or not active', 404);
  await logAudit('library_suspended', lib._id, userId, { reason, libraryName: lib.name }, ip);
  return lib;
};

exports.reinstateLibrary = async (id, userId, ip) => {
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false, status: 'suspended' }, { status: 'active', statusReason: null }, { new: true }
  ).select('-password');
  if (!lib) throw err('Library not found or not suspended', 404);
  await logAudit('library_reinstated', lib._id, userId, { libraryName: lib.name }, ip);
  return lib;
};

exports.assignPlan = async (id, planId, subscriptionExpiry, userId, ip) => {
  if (!planId) throw err('planId is required', 400);
  const plan = await PlatformPlan.findOne({ _id: planId, isDeleted: false, isActive: true });
  if (!plan) throw err('Platform plan not found or inactive', 404);
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false },
    {
      subscriptionPlanId: plan._id, subscriptionPlan: plan.name,
      subscriptionExpiry: subscriptionExpiry ? new Date(subscriptionExpiry) : null,
      'planLimits.maxStudents': plan.maxStudents,
      'planLimits.maxSeats': plan.maxSeats,
      'planLimits.maxStaff': plan.maxStaff,
    },
    { new: true }
  ).select('-password');
  if (!lib) throw err('Library not found', 404);
  await logAudit('library_plan_assigned', lib._id, userId, { planName: plan.name, planId: plan._id }, ip);
  return { lib, planName: plan.name };
};

exports.getLibraryPlan = async (id) => {
  const lib = await Library.findOne({ _id: id, isDeleted: false })
    .select('name subscriptionPlan subscriptionPlanId subscriptionExpiry planLimits')
    .populate('subscriptionPlanId');
  if (!lib) throw err('Library not found', 404);
  return lib;
};

exports.createLibrary = async (body, userId, ip) => {
  const { name, ownerName, email, mobile, password, address, city, state, country, pincode, alternativeMobileNumber } = body;
  if (!name || !ownerName || !email || !mobile || !password)
    throw err('name, ownerName, email, mobile and password are required', 400);
  if (await Library.findOne({ email })) throw err('A library with this email already exists', 400);
  if (await Admin.findOne({ email }))   throw err('An admin with this email already exists', 400);

  let adminRole = await Role.findOne({ name: 'Admin' });

  const library = await new Library({
    name, ownerName, mobile, alternativeMobileNumber, email, password,
    address, city, state, country: country || 'India', pincode,
    status: 'active',
    createdBy: 'SUPER_ADMIN', createdById: userId,
  }).save();

  const admin = await Admin.create({
    name: ownerName, email, password, userType: 'admin',
    roleId: adminRole?._id || null, libraryId: library._id,
    mobile, alternativeMobileNumber, address, city, state, pincode,
    createdBy: userId,
  });

  await logAudit('library_created', library._id, userId, { libraryName: name }, ip);
  return { library, admin };
};

exports.updateLibrary = async (id, body, userId, ip) => {
  const FIELDS = ['name','ownerName','email','mobile','alternativeMobileNumber','address','city','state','country','pincode','website','gstNumber'];
  const update = {};
  FIELDS.forEach(k => { if (body[k] !== undefined) update[k] = body[k]; });
  if (!Object.keys(update).length) throw err('No fields to update', 400);

  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false }, { $set: update }, { new: true, runValidators: true }
  ).select('-password');
  if (!lib) throw err('Library not found', 404);

  // Sync admin account fields
  const adminUpdate = {};
  ['name','email','mobile','alternativeMobileNumber','address','city','state','country','pincode']
    .forEach(k => { if (update[k] !== undefined) adminUpdate[k === 'name' ? 'name' : k] = update[k]; });
  if (update.ownerName) adminUpdate.name = update.ownerName;
  if (Object.keys(adminUpdate).length) {
    await Admin.updateOne({ libraryId: id, userType: 'admin', isDeleted: false }, { $set: adminUpdate });
  }

  await logAudit('library_updated', lib._id, userId, { fields: Object.keys(update) }, ip);
  return lib;
};

exports.deleteLibrary = async (id, userId, ip) => {
  const lib = await Library.findOne({ _id: id, isDeleted: false });
  if (!lib) throw err('Library not found', 404);

  await Library.findByIdAndUpdate(id, { isDeleted: true, status: 'rejected', statusReason: 'Deleted by superadmin' });
  await Admin.updateMany({ libraryId: id, isDeleted: false }, { $set: { isDeleted: true } });
  await logAudit('library_deleted', lib._id, userId, { libraryName: lib.name }, ip);
};
