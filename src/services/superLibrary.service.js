const jwt          = require('jsonwebtoken');
const Library      = require('../models/library.model');
const Admin        = require('../models/admin.model');
const Student      = require('../models/student.model');
const PlatformPlan = require('../models/platformPlan.model');
const AuditLog     = require('../models/auditLog.model');
const config       = require('../config/config');
const pick         = require('../utils/pick');
const escapeRegex  = require('../utils/escapeRegex');
const { normalizeMobile } = require('../utils/mobile');
const { isValidSlug, isReserved, isTaken } = require('../utils/slug');
const { getSubscriptionState } = require('./subscriptionState.service');
const { provisionLibrary } = require('./libraryProvision.service');
const adminService = require('./admin.service');

const err = (msg, status) => Object.assign(new Error(msg), { status });

const logAudit = async (action, libraryId, userId, metadata, ipAddress, extra = {}) => {
  try {
    await AuditLog.create({
      action, resource: 'Library', resourceId: libraryId, libraryId,
      userId, userType: 'superadmin', metadata, ipAddress, ...extra,
    });
  } catch (_) { /* audit must never break the action */ }
};

exports.listLibraries = async (query) => {
  const { search, status } = query;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const filter = { isDeleted: false };
  if (status && status !== 'all') filter.status = status;
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: re }, { ownerName: re }, { mobile: re }, { email: re }, { city: re }, { state: re }, { libraryCode: re }, { slug: re }];
  }
  const [libraries, total, totalAll, active, pending, suspended, rejected] = await Promise.all([
    Library.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Library.countDocuments(filter),
    Library.countDocuments({ isDeleted: false }),
    Library.countDocuments({ isDeleted: false, status: 'active' }),
    Library.countDocuments({ isDeleted: false, status: 'pending' }),
    Library.countDocuments({ isDeleted: false, status: 'suspended' }),
    Library.countDocuments({ isDeleted: false, status: 'rejected' }),
  ]);
  return {
    libraries,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    counts: { total: totalAll, active, pending, suspended, rejected },
  };
};

exports.getLibraryById = async (id) => {
  const library = await Library.findOne({ _id: id, isDeleted: false });
  if (!library) throw err('Library not found', 404);
  const [studentCount, owner] = await Promise.all([
    Student.countDocuments({ libraryId: id, isDeleted: false }),
    Admin.findOne({ libraryId: id, userType: 'admin' }).select('name email mobile status lastLogin'),
  ]);
  return { ...library.toObject(), studentCount, owner, subscription: getSubscriptionState(library) };
};

// pending/rejected -> active. Provisions slug/subdomain, trial and an in-app owner notification.
exports.approveLibrary = async (id, userId, ip) => {
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false, status: { $in: ['pending', 'rejected'] } },
    { status: 'active', statusReason: null, approvedAt: new Date(), approvedBy: userId },
    { new: true }
  );
  if (!lib) throw err('Library not found or not awaiting approval', 404);
  const { library, onboarding } = await provisionLibrary(lib, { approvedBy: userId });
  // (owner notification is sent from provisionLibrary)
  await logAudit('library_approved', lib._id, userId, { libraryName: lib.name, slug: library.slug }, ip);
  return { library, onboarding };
};

exports.rejectLibrary = async (id, reason, userId, ip) => {
  if (!reason?.trim()) throw err('Rejection reason is required', 400);
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false, status: 'pending' }, { status: 'rejected', statusReason: reason.trim() }, { new: true }
  );
  if (!lib) throw err('Library not found or not pending', 404);
  await logAudit('library_rejected', lib._id, userId, { reason, libraryName: lib.name }, ip);
  require('./notification.service').notifyLibraryStatus(lib, 'rejected', reason.trim()).catch(() => {});
  return lib;
};

exports.suspendLibrary = async (id, reason, userId, ip) => {
  if (!reason?.trim()) throw err('Suspension reason is required', 400);
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false, status: 'active' }, { status: 'suspended', statusReason: reason.trim() }, { new: true }
  );
  if (!lib) throw err('Library not found or not active', 404);
  await logAudit('library_suspended', lib._id, userId, { reason, libraryName: lib.name }, ip);
  require('./notification.service').notifyLibraryStatus(lib, 'suspended', reason.trim()).catch(() => {});
  return lib;
};

exports.reinstateLibrary = async (id, userId, ip) => {
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false, status: 'suspended' }, { status: 'active', statusReason: null }, { new: true }
  );
  if (!lib) throw err('Library not found or not suspended', 404);
  await logAudit('library_reinstated', lib._id, userId, { libraryName: lib.name }, ip);
  require('./notification.service').notifyLibraryStatus(lib, 'reinstated').catch(() => {});
  return lib;
};

const planLimitsOf = (plan) => ({
  'planLimits.maxStudents': plan.maxStudents,
  'planLimits.maxSeats': plan.maxSeats,
  'planLimits.maxStaff': plan.maxStaff,
  'planLimits.maxBranches': plan.maxBranches || 0,
});
exports.planLimitsOf = planLimitsOf;

exports.assignPlan = async (id, planId, subscriptionExpiry, userId, ip, { isTrial = false } = {}) => {
  if (!planId) throw err('planId is required', 400);
  const plan = await PlatformPlan.findOne({ _id: planId, isDeleted: false, isActive: true });
  if (!plan) throw err('Platform plan not found or inactive', 404);
  const expiry = subscriptionExpiry ? new Date(subscriptionExpiry) : null;
  if (expiry && isNaN(expiry)) throw err('Invalid subscription expiry date', 400);
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false },
    {
      subscriptionPlanId: plan._id, subscriptionPlan: plan.name,
      subscriptionExpiry: expiry,
      subscriptionIsTrial: !!isTrial,
      trialEndsAt: null,           // an explicit assignment supersedes the onboarding trial window
      ...planLimitsOf(plan),
    },
    { new: true }
  );
  if (!lib) throw err('Library not found', 404);
  await logAudit('library_plan_assigned', lib._id, userId, { planName: plan.name, planId: plan._id, expiry, isTrial: !!isTrial }, ip);
  return { lib, planName: plan.name };
};

exports.getLibraryPlan = async (id) => {
  const lib = await Library.findOne({ _id: id, isDeleted: false })
    .select('name subscriptionPlan subscriptionPlanId subscriptionExpiry planLimits trialEndsAt subscriptionIsTrial')
    .populate('subscriptionPlanId');
  if (!lib) throw err('Library not found', 404);
  return { ...lib.toObject(), subscription: getSubscriptionState(lib) };
};

// Superadmin creates an active library (+ owner account) directly
exports.createLibrary = async (body, user, ip) => {
  const { library, admin, onboarding } = await adminService.createLibraryWithAdmin(
    { ...body, country: body.country || 'India' }, null, { _id: user._id, userType: 'superadmin' }
  );
  await logAudit('library_created', library._id, user._id, { libraryName: library.name }, ip);
  return { library, admin, onboarding };
};

exports.updateLibrary = async (id, body, userId, ip) => {
  const FIELDS = ['name', 'ownerName', 'email', 'mobile', 'alternativeMobileNumber', 'address', 'city', 'state', 'country', 'pincode', 'website', 'gstNumber'];
  const update = pick(body, FIELDS);
  if (!Object.keys(update).length) throw err('No fields to update', 400);
  if (update.mobile) update.mobile = normalizeMobile(update.mobile);
  if (update.alternativeMobileNumber) update.alternativeMobileNumber = normalizeMobile(update.alternativeMobileNumber);
  if (update.email) update.email = String(update.email).toLowerCase();

  const current = await Library.findOne({ _id: id, isDeleted: false });
  if (!current) throw err('Library not found', 404);
  const owner = await Admin.findOne({ libraryId: id, userType: 'admin' });

  if (update.mobile && update.mobile !== current.mobile &&
      await Library.findOne({ mobile: update.mobile, _id: { $ne: id }, isDeleted: false })) {
    throw err('A library with this mobile number already exists', 409);
  }
  if (update.email && owner && update.email !== owner.email &&
      await Admin.findOne({ email: update.email, _id: { $ne: owner._id } })) {
    throw err('An account with this email already exists', 409);
  }

  const lib = await Library.findOneAndUpdate({ _id: id, isDeleted: false }, { $set: update }, { new: true, runValidators: true });

  // Mirror contact fields to the owner account. Owner NAME comes only from ownerName (never the library name).
  if (owner) {
    const adminUpdate = pick(update, ['email', 'mobile', 'alternativeMobileNumber', 'address', 'city', 'state', 'country', 'pincode']);
    if (update.ownerName) adminUpdate.name = update.ownerName;
    if (Object.keys(adminUpdate).length) await Admin.updateOne({ _id: owner._id }, { $set: adminUpdate });
  }

  await logAudit('library_updated', lib._id, userId, { fields: Object.keys(update) }, ip);
  return lib;
};

exports.deleteLibrary = async (id, userId, ip) => {
  const lib = await Library.findOne({ _id: id, isDeleted: false });
  if (!lib) throw err('Library not found', 404);

  await Library.updateOne({ _id: id }, { isDeleted: true, status: 'rejected', statusReason: 'Deleted by superadmin' });
  await Admin.updateMany({ libraryId: id, isDeleted: false }, { $set: { isDeleted: true, status: false } });
  await logAudit('library_deleted', lib._id, userId, { libraryName: lib.name }, ip);
};

// Controlled slug change: validated, unique, old slug kept for redirects
exports.changeSlug = async (id, rawSlug, userId, ip) => {
  const slug = String(rawSlug || '').trim().toLowerCase();
  if (isReserved(slug)) throw err('This subdomain is reserved', 400);
  if (!isValidSlug(slug)) throw err('Slug must be 3-63 characters: lowercase letters, digits and hyphens, not starting or ending with a hyphen', 400);

  const lib = await Library.findOne({ _id: id, isDeleted: false });
  if (!lib) throw err('Library not found', 404);
  if (lib.slug === slug) throw err('Library already uses this slug', 400);
  // taken by another library (current or historical)
  if (await isTaken(Library, slug, lib._id)) throw err('This slug is already in use', 409);

  const previous = new Set((lib.previousSlugs || []).filter((s) => s !== slug));
  if (lib.slug) previous.add(lib.slug);
  const oldSlug = lib.slug || null;
  lib.slug = slug;
  lib.previousSlugs = [...previous];
  lib.slugChangedAt = new Date();
  await lib.save(); // E11000 on a race is mapped to 409 by the error handler

  await logAudit('library_slug_changed', lib._id, userId, { from: oldSlug, to: slug }, ip);
  return lib;
};

// Short-lived scoped token acting as the library owner. Every use is attributable via the impersonatedBy claim.
exports.impersonate = async (id, superAdmin, ip) => {
  const lib = await Library.findOne({ _id: id, isDeleted: false });
  if (!lib) throw err('Library not found', 404);
  if (lib.status !== 'active') throw err(`Library is ${lib.status}; only active libraries can be impersonated`, 400);
  const owner = await Admin.findOne({ libraryId: id, userType: 'admin', status: true });
  if (!owner) throw err('Library owner account not found or disabled', 404);

  const expiresInSec = 30 * 60;
  const token = jwt.sign(
    { id: owner._id, type: 'admin', impersonatedBy: superAdmin._id },
    config.jwt.secret,
    { expiresIn: expiresInSec }
  );
  await logAudit('library_impersonation_started', lib._id, superAdmin._id,
    { libraryName: lib.name, ownerId: owner._id, expiresInSeconds: expiresInSec }, ip);
  return {
    token,
    expiresAt: new Date(Date.now() + expiresInSec * 1000),
    library: { id: lib._id, name: lib.name, slug: lib.slug },
    user: { id: owner._id, name: owner.name, email: owner.email, userType: 'admin' },
    impersonatedBy: superAdmin._id,
  };
};
