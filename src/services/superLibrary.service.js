const jwt          = require('jsonwebtoken');
const Library      = require('../models/library.model');
const Admin        = require('../models/admin.model');
const Student      = require('../models/student.model');
const Seat         = require('../models/seat.model');
const Branch       = require('../models/branch.model');
const PlatformPlan = require('../models/platformPlan.model');
const AuditLog     = require('../models/auditLog.model');
const config       = require('../config/config');
const pick         = require('../utils/pick');
const escapeRegex  = require('../utils/escapeRegex');
const { normalizeMobile } = require('../utils/mobile');
const { invalidateAuthCacheForLibrary } = require('../middlewares/auth.middleware');
const { getSubscriptionState } = require('./subscriptionState.service');
const { SUSPEND_REASON } = require('../utils/subscriptionLifecycle');
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

const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name_asc: { name: 1 },
  name_desc: { name: -1 },
  expiry_soon: { subscriptionExpiry: 1, createdAt: -1 },
};
const exactCI = (v) => new RegExp(`^${escapeRegex(String(v).trim())}$`, 'i');

exports.listLibraries = async (query) => {
  const { search, status, city, state, plan, subscription } = query;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const filter = { isDeleted: false };
  const and = [];
  // "All Libraries" never lists pending requests (they live on the Pending Requests page)
  if (status && status !== 'all') filter.status = status;
  else if (query.excludePending === 'true' || query.excludePending === true) filter.status = { $ne: 'pending' };
  if (city && city !== 'all') filter.city = exactCI(city);
  if (state && state !== 'all') filter.state = exactCI(state);
  if (plan && plan !== 'all') {
    // "free" = no platform plan assigned
    if (String(plan).toLowerCase() === 'free') and.push({ $or: [{ subscriptionPlan: null }, { subscriptionPlan: '' }, { subscriptionPlan: exactCI('free') }, { subscriptionPlan: { $exists: false } }] });
    else filter.subscriptionPlan = exactCI(plan);
  }
  const now = new Date();
  // A trial library has no subscriptionExpiry, only trialEndsAt: both count as "the subscription end"
  const endsBefore = (d) => ({ $or: [{ subscriptionExpiry: { $lt: d } }, { subscriptionExpiry: null, trialEndsAt: { $lt: d } }] });
  const endsBetween = (a, b) => ({ $or: [{ subscriptionExpiry: { $gte: a, $lte: b } }, { subscriptionExpiry: null, trialEndsAt: { $gte: a, $lte: b } }] });
  if (subscription === 'expired') and.push(endsBefore(now));
  else if (subscription === 'expiring') and.push(endsBetween(now, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)));
  else if (subscription === 'no_plan') and.push({ $or: [{ subscriptionPlanId: null }, { subscriptionPlanId: { $exists: false } }] });
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    and.push({ $or: [{ name: re }, { ownerName: re }, { mobile: re }, { email: re }, { city: re }, { state: re }, { libraryCode: re }] });
  }
  if (and.length) filter.$and = and;
  const sort = SORTS[query.sort] || SORTS.newest;

  // 5 round trips instead of 10 (each one is slow on a remote database): the status counts and the
  // filter dropdown values each come from a single aggregate.
  const [rows, total, statusAgg, facets] = await Promise.all([
    Library.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).populate('subscriptionPlanId', 'graceDays name'),
    Library.countDocuments(filter),
    Library.aggregate([{ $match: { isDeleted: false } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Library.aggregate([
      { $match: { isDeleted: false } },
      { $facet: {
        cities: [{ $group: { _id: '$city' } }],
        states: [{ $group: { _id: '$state' } }],
        plans: [{ $group: { _id: '$subscriptionPlan' } }],
      } },
    ]),
  ]);
  const byStatus = Object.fromEntries(statusAgg.map((x) => [x._id, x.n]));
  const active = byStatus.active || 0;
  const pending = byStatus.pending || 0;
  const suspended = byStatus.suspended || 0;
  const rejected = byStatus.rejected || 0;
  const totalAll = statusAgg.reduce((sum, x) => sum + x.n, 0);
  const f = facets[0] || {};
  const cities = (f.cities || []).map((x) => x._id);
  const states = (f.states || []).map((x) => x._id);
  const plans = (f.plans || []).map((x) => x._id);

  // Student counts for just this page (one grouped query) + computed subscription state
  const ids = rows.map((l) => l._id);
  const counts = ids.length
    ? await Student.aggregate([
        { $match: { libraryId: { $in: ids }, isDeleted: false } },
        { $group: { _id: '$libraryId', n: { $sum: 1 } } },
      ])
    : [];
  const studentCounts = new Map(counts.map((c) => [String(c._id), c.n]));
  const libraries = rows.map((l) => {
    const o = l.toObject();
    // populate() is only used to read graceDays; keep the plain id on the payload
    const plan = o.subscriptionPlanId && o.subscriptionPlanId._id ? o.subscriptionPlanId : null;
    if (plan) o.subscriptionPlanId = plan._id;
    return { ...o, studentCount: studentCounts.get(String(l._id)) || 0, subscription: getSubscriptionState(l, plan) };
  });

  const clean = (arr) => arr.filter((x) => typeof x === 'string' && x.trim()).sort((a, b) => a.localeCompare(b));
  return {
    libraries,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    counts: { total: totalAll, registered: totalAll - pending, active, pending, suspended, rejected },
    filters: { cities: clean(cities), states: clean(states), plans: clean(plans) },
  };
};

exports.getLibraryById = async (id) => {
  const library = await Library.findOne({ _id: id, isDeleted: false });
  if (!library) throw err('Library not found', 404);
  const plan = library.subscriptionPlanId ? await PlatformPlan.findById(library.subscriptionPlanId).select('graceDays').lean() : null;
  const [studentCount, owner, seatCount, staffCount, branchCount] = await Promise.all([
    Student.countDocuments({ libraryId: id, isDeleted: false }),
    Admin.findOne({ libraryId: id, userType: 'admin' }).select('name email mobile status lastLogin profileImage'),
    Seat.countDocuments({ libraryId: id, isDeleted: { $ne: true } }),
    Admin.countDocuments({ libraryId: id, userType: 'staff', isDeleted: false }),
    Branch.countDocuments({ libraryId: id, isDeleted: { $ne: true } }),
  ]);
  return {
    ...library.toObject(), studentCount, owner, subscription: getSubscriptionState(library, plan),
    usage: { students: studentCount, seats: seatCount, staff: staffCount, branches: branchCount },
  };
};

// pending/rejected -> active. Provisions the trial and an in-app owner notification.
// If provisioning throws, the claim is rolled back so the library stays pending/rejected and can be approved again
// (instead of being left active without a trial window).
exports.approveLibrary = async (id, userId, ip) => {
  const prior = await Library.findOne({ _id: id, isDeleted: false, status: { $in: ['pending', 'rejected'] } });
  if (!prior) throw err('Library not found or not awaiting approval', 404);
  const priorState = { status: prior.status, statusReason: prior.statusReason ?? null };
  // claim: compare-and-set so two concurrent approvals cannot both provision
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false, status: priorState.status },
    { status: 'active', statusReason: null, approvedAt: new Date(), approvedBy: userId },
    { new: true }
  );
  if (!lib) throw err('Library not found or not awaiting approval', 404);
  let result;
  try {
    result = await provisionLibrary(lib, { approvedBy: userId });
  } catch (e) {
    await Library.updateOne({ _id: id, status: 'active' }, { $set: { ...priorState, approvedAt: prior.approvedAt ?? null, approvedBy: prior.approvedBy ?? null } });
    invalidateAuthCacheForLibrary(id);
    throw e;
  }
  invalidateAuthCacheForLibrary(id);
  // (owner notification is sent from provisionLibrary)
  await logAudit('library_approved', lib._id, userId, { libraryName: lib.name }, ip);
  return result;
};

exports.rejectLibrary = async (id, reason, userId, ip) => {
  if (!reason?.trim()) throw err('Rejection reason is required', 400);
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false, status: 'pending' }, { status: 'rejected', statusReason: reason.trim() }, { new: true }
  );
  if (!lib) throw err('Library not found or not pending', 404);
  invalidateAuthCacheForLibrary(lib._id);
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
  invalidateAuthCacheForLibrary(lib._id);
  await logAudit('library_suspended', lib._id, userId, { reason, libraryName: lib.name }, ip);
  require('./notification.service').notifyLibraryStatus(lib, 'suspended', reason.trim()).catch(() => {});
  return lib;
};

// Reinstating must also lift the lapse that may have caused the suspension: if the subscription end (and grace) is
// already in the past the 02:00 cron would suspend the library again, so a short fresh period is granted.
const REINSTATE_EXTENSION_DAYS = 7;
exports.reinstateLibrary = async (id, userId, ip) => {
  const current = await Library.findOne({ _id: id, isDeleted: false, status: 'suspended' });
  if (!current) throw err('Library not found or not suspended', 404);
  const plan = current.subscriptionPlanId ? await PlatformPlan.findById(current.subscriptionPlanId).select('graceDays').lean() : null;
  const st = getSubscriptionState(current, plan);
  const set = { status: 'active', statusReason: null };
  const update = { $set: set };
  let extendedTo = null;
  if (st.isExpired) {
    extendedTo = new Date(Date.now() + REINSTATE_EXTENSION_DAYS * 24 * 60 * 60 * 1000);
    if (current.subscriptionExpiry) set.subscriptionExpiry = extendedTo; else set.trialEndsAt = extendedTo;
    set.subscriptionStatus = current.subscriptionExpiry && !current.subscriptionIsTrial ? 'active' : 'trial';
    update.$unset = { lastReminderStage: '' };
  } else if (current.subscriptionStatus === 'expired') {
    set.subscriptionStatus = st.state === 'grace' ? 'grace' : (current.subscriptionIsTrial || !current.subscriptionExpiry ? 'trial' : 'active');
  }
  const lib = await Library.findOneAndUpdate({ _id: id, isDeleted: false, status: 'suspended' }, update, { new: true });
  if (!lib) throw err('Library not found or not suspended', 404);
  invalidateAuthCacheForLibrary(lib._id);
  await logAudit('library_reinstated', lib._id, userId, { libraryName: lib.name, extendedTo }, ip);
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
  const stillRunning = !expiry || expiry.getTime() > Date.now();
  const lib = await Library.findOneAndUpdate(
    { _id: id, isDeleted: false },
    {
      $set: {
        subscriptionPlanId: plan._id, subscriptionPlan: plan.name,
        subscriptionExpiry: expiry,
        subscriptionIsTrial: !!isTrial,
        trialEndsAt: null,           // an explicit assignment supersedes the onboarding trial window
        subscriptionStatus: !stillRunning ? 'expired' : (isTrial ? 'trial' : 'active'),
        cancelAtPeriodEnd: false,    // a manual assignment replaces any scheduled cancellation / plan change
        ...planLimitsOf(plan),
      },
      $unset: { pendingPlanChange: '', cancelReason: '', cancelRequestedAt: '', lastReminderStage: '' },
    },
    { new: true }
  );
  if (!lib) throw err('Library not found', 404);
  // A library the lifecycle suspended for non-payment comes back once it has a running subscription again
  // (manual suspensions by the super admin keep their own reason and stay suspended).
  let reinstated = false;
  if (stillRunning) {
    const r = await Library.updateOne(
      { _id: lib._id, status: 'suspended', statusReason: SUSPEND_REASON, isDeleted: false },
      { $set: { status: 'active', statusReason: null } }
    );
    reinstated = !!r.modifiedCount;
  }
  invalidateAuthCacheForLibrary(lib._id);
  await logAudit('library_plan_assigned', lib._id, userId, { planName: plan.name, planId: plan._id, expiry, isTrial: !!isTrial, reinstated }, ip);
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
exports.createLibrary = async (body, user, ip, files = null) => {
  const { library, admin, onboarding } = await adminService.createLibraryWithAdmin(
    { ...body, country: body.country || 'India' }, files, { _id: user._id, userType: 'superadmin' }
  );
  await logAudit('library_created', library._id, user._id, { libraryName: library.name }, ip);
  return { library, admin, onboarding };
};

// delete an uploaded file we own (path must stay inside uploads/)
const removeUpload = (rel) => {
  try {
    if (!rel) return;
    const root = require('path').resolve(process.cwd(), 'uploads');
    const full = require('path').resolve(process.cwd(), String(rel).replace(/\\/g, '/'));
    if (full.startsWith(root + require('path').sep)) require('fs').unlinkSync(full);
  } catch (_) { /* already gone */ }
};

exports.updateLibrary = async (id, body, userId, ip, { file = null, removeImage = false } = {}) => {
  const FIELDS = ['name', 'ownerName', 'email', 'mobile', 'alternativeMobileNumber', 'address', 'city', 'state', 'country', 'pincode', 'website', 'gstNumber'];
  const update = pick(body, FIELDS);
  if (!Object.keys(update).length && !file && !removeImage) throw err('No fields to update', 400);
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

  const lib = Object.keys(update).length
    ? await Library.findOneAndUpdate({ _id: id, isDeleted: false }, { $set: update }, { new: true, runValidators: true })
    : current;

  // Mirror contact fields to the owner account. Owner NAME comes only from ownerName (never the library name).
  if (owner) {
    const adminUpdate = pick(update, ['email', 'mobile', 'alternativeMobileNumber', 'address', 'city', 'state', 'country', 'pincode']);
    if (update.ownerName) adminUpdate.name = update.ownerName;
    // owner photo: a new upload replaces the old one; "remove" clears it
    if (file) { adminUpdate.profileImage = String(file.path).replace(/\\/g, '/'); removeUpload(owner.profileImage); }
    else if (removeImage && owner.profileImage) { adminUpdate.profileImage = ''; removeUpload(owner.profileImage); }
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
  invalidateAuthCacheForLibrary(id);
  await logAudit('library_deleted', lib._id, userId, { libraryName: lib.name }, ip);
};

// Short-lived scoped token acting as the library owner. Every use is attributable via the impersonatedBy claim.
exports.impersonate = async (id, superAdmin, ip) => {
  const lib = await Library.findOne({ _id: id, isDeleted: false });
  if (!lib) throw err('Library not found', 404);
  if (lib.status !== 'active') throw err(`Library is ${lib.status}; only active libraries can be impersonated`, 400);
  const owner = await Admin.findOne({ libraryId: id, userType: 'admin', status: true });
  if (!owner) throw err('Library owner account not found or disabled', 404);

  const expiresInSec = 30 * 60;
  // A revocable support session (no refresh token): ends on expiry, or at once if revoked / the superadmin is disabled
  const { token, sessionId } = await require('./session.service').createImpersonationSession({ owner, superAdminId: superAdmin._id, ttlSeconds: expiresInSec, ip });
  await logAudit('library_impersonation_started', lib._id, superAdmin._id,
    { libraryName: lib.name, ownerId: owner._id, expiresInSeconds: expiresInSec, sessionId }, ip);
  return {
    token,
    expiresAt: new Date(Date.now() + expiresInSec * 1000),
    library: { id: lib._id, name: lib.name },
    user: { id: owner._id, name: owner.name, email: owner.email, userType: 'admin' },
    impersonatedBy: superAdmin._id,
  };
};
