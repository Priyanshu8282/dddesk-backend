const Library = require('../models/library.model');
const Student = require('../models/student.model');
const Seat = require('../models/seat.model');
const Admin = require('../models/admin.model');
const ApiError = require('../utils/ApiError');
const pick = require('../utils/pick');
const audit = require('../utils/audit');
const { getSubscriptionState } = require('./subscriptionState.service');

// Library profile & settings (spec section 7). Only these keys can ever be written by an owner.
const FLAT_FIELDS = [
  'name', 'description', 'alternativeMobileNumber', 'email', 'address', 'city', 'state', 'country', 'pincode',
  'website', 'gstNumber', 'facilities', 'seatCapacity', 'weeklyHolidays', 'rules', 'terms', 'timezone', 'currency',
];
const NESTED_FIELDS = [
  'mapLocation', 'socialLinks', 'workingHours', 'feePolicy', 'attendanceRules', 'notificationPrefs', 'receipt', 'brand', 'settings',
];
const REMOVE_FLAGS = ['', 'null', 'REMOVE_IMAGE'];
const MAX_PHOTOS = 20;

const normPath = (p) => (p ? String(p).replace(/\\/g, '/') : p);
const fileList = (files) => (Array.isArray(files) ? files : []);

exports.getProfile = async (libraryId) => {
  const library = await Library.findOne({ _id: libraryId, isDeleted: false });
  if (!library) throw new ApiError(404, 'Library not found');
  return library;
};

exports.updateProfile = async (req, libraryId) => {
  const library = await exports.getProfile(libraryId);
  const body = req.body || {};
  const files = fileList(req.files);

  const $set = pick(body, FLAT_FIELDS);
  for (const key of NESTED_FIELDS) {
    const value = body[key];
    if (value && typeof value === 'object') {
      for (const [sub, v] of Object.entries(value)) {
        if (v !== undefined) $set[`${key}.${sub}`] = v;
      }
    }
  }

  // Receipt numbering must never go backwards (duplicate receipt numbers)
  if ($set['receipt.nextNumber'] !== undefined && $set['receipt.nextNumber'] < (library.receipt?.nextNumber || 1)) {
    throw new ApiError(400, `Receipt number cannot be lower than the current counter (${library.receipt.nextNumber})`);
  }

  // Images
  const logo = files.find((f) => f.fieldname === 'logo');
  const cover = files.find((f) => f.fieldname === 'coverImage');
  if (logo) $set.logo = normPath(logo.path);
  else if (REMOVE_FLAGS.includes(body.logo)) $set.logo = null;
  if (cover) $set.coverImage = normPath(cover.path);
  else if (REMOVE_FLAGS.includes(body.coverImage)) $set.coverImage = null;

  const newPhotos = files.filter((f) => f.fieldname === 'photos').map((f) => normPath(f.path));
  if (newPhotos.length || body.existingPhotos !== undefined) {
    let keep = library.photos || [];
    if (body.existingPhotos !== undefined) {
      let parsed = [];
      try { parsed = JSON.parse(body.existingPhotos); } catch (_) { parsed = []; }
      // Only photos this library already owns can be kept - never arbitrary client-supplied paths
      keep = Array.isArray(parsed) ? parsed.filter((p) => (library.photos || []).includes(p)) : [];
    }
    $set.photos = [...keep, ...newPhotos].slice(0, MAX_PHOTOS);
  }

  if (!Object.keys($set).length) throw new ApiError(400, 'No valid fields to update');

  const updated = await Library.findOneAndUpdate(
    { _id: library._id },
    { $set },
    { new: true, runValidators: true }
  );

  await audit(req, 'library.profile_update', 'Library', library._id, { fields: Object.keys($set) });
  return updated;
};

// Subscription + usage for the owner "my plan" screen
exports.getMyPlan = async (libraryId) => {
  const lib = await Library.findOne({ _id: libraryId, isDeleted: false })
    .select('name subscriptionPlan subscriptionPlanId subscriptionExpiry planLimits trialEndsAt subscriptionIsTrial approvedAt')
    .populate('subscriptionPlanId', 'name description monthlyPrice annualPrice features trialDays graceDays');
  if (!lib) throw new ApiError(404, 'Library not found');

  const subscription = getSubscriptionState(lib);
  const [students, seats, staff] = await Promise.all([
    Student.countDocuments({ libraryId: lib._id, isDeleted: false }),
    Seat.countDocuments({ libraryId: lib._id, isDeleted: false }),
    Admin.countDocuments({ libraryId: lib._id, userType: 'staff' }),
  ]);
  const limits = lib.planLimits || {};
  return {
    ...lib.toObject(),
    isExpired: subscription.isExpired,
    subscription,
    usage: {
      students: { used: students, limit: limits.maxStudents ?? null },
      seats: { used: seats, limit: limits.maxSeats ?? null },
      staff: { used: staff, limit: limits.maxStaff ?? null },
    },
  };
};
