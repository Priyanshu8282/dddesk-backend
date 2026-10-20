const Branch = require('../models/branch.model');
const Admin = require('../models/admin.model');
const Student = require('../models/student.model');
const Seat = require('../models/seat.model');
const Payment = require('../models/payment.model');
const pick = require('../utils/pick');
const escapeRegex = require('../utils/escapeRegex');

// "06:00 AM" / "18:30" -> minutes since midnight (null when not a time)
const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(t || '').trim());
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) { h %= 12; if (m[3].toUpperCase() === 'PM') h += 12; }
  return h * 60 + Number(m[2]);
};

const fail = (message, status) => Object.assign(new Error(message), { status });

const CREATE_FIELDS = ['name', 'address', 'city', 'state', 'pincode', 'mobile', 'email', 'openingTime', 'closingTime', 'maxStudents', 'maxSeats', 'notes'];
const UPDATE_FIELDS = [...CREATE_FIELDS, 'isActive'];

const assertTimes = (opening, closing) => {
  const o = toMin(opening);
  const c = toMin(closing);
  if (o !== null && c !== null && c <= o) throw fail('Closing time must be after opening time.', 400);
};

// Manager must be a live admin/staff account of the same library
const assertManager = async (managerId, libraryId) => {
  if (!managerId) return null;
  const m = await Admin.findOne({ _id: managerId, libraryId, status: true, userType: { $in: ['admin', 'staff'] } }).select('_id');
  if (!m) throw fail('Manager must be an active staff member of this library.', 400);
  return m._id;
};

const assertUniqueName = async (libraryId, name, excludeId) => {
  const q = { libraryId, isDeleted: false, name: new RegExp(`^${escapeRegex(name.trim())}$`, 'i') };
  if (excludeId) q._id = { $ne: excludeId };
  if (await Branch.exists(q)) throw fail('A branch with this name already exists.', 409);
};

const SORTS = {
  main: { isMain: -1, createdAt: 1 },
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name: { name: 1 },
  city: { city: 1, name: 1 },
};

const NO_COUNTS = () => ({ studentCount: 0, seatCount: 0 });

// Students and seats per branch (one grouped query each, not one per branch)
const countsFor = async (libraryId, ids) => {
  if (!ids.length) return NO_COUNTS;
  const match = { libraryId, isDeleted: false, branchId: { $in: ids } };
  const [stu, seat] = await Promise.all([
    Student.aggregate([{ $match: match }, { $group: { _id: '$branchId', n: { $sum: 1 } } }]),
    Seat.aggregate([{ $match: match }, { $group: { _id: '$branchId', n: { $sum: 1 } } }]),
  ]);
  const sm = new Map(stu.map((r) => [String(r._id), r.n]));
  const tm = new Map(seat.map((r) => [String(r._id), r.n]));
  return (id) => ({ studentCount: sm.get(String(id)) || 0, seatCount: tm.get(String(id)) || 0 });
};

exports.listBranches = async (libraryId, { search = '', page = 1, limit = 50, isActive, status, city = '', sort = 'main' } = {}) => {
  const base = { libraryId, isDeleted: false };
  const filter = { ...base };
  if (search) {
    const rx = { $regex: escapeRegex(String(search).trim()), $options: 'i' };
    filter.$or = [{ name: rx }, { city: rx }, { address: rx }, { pincode: rx }];
  }
  if (isActive !== undefined && isActive !== '') filter.isActive = String(isActive) === 'true';
  if (status === 'active') filter.isActive = true;
  if (status === 'inactive') filter.isActive = false;
  if (city) filter.city = new RegExp(`^${escapeRegex(String(city).trim())}$`, 'i');
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(200, Math.max(1, Number(limit) || 50));
  const [rows, total, all, cities] = await Promise.all([
    Branch.find(filter)
      .populate('managerId', 'name email mobile')
      .sort(SORTS[sort] || SORTS.main)
      .skip((p - 1) * l).limit(l).lean(),
    Branch.countDocuments(filter),
    Branch.find(base).select('isMain isActive name').lean(),
    Branch.distinct('city', { ...base, city: { $ne: '' } }),
  ]);
  const countOf = await countsFor(libraryId, rows.map((r) => r._id));
  const data = rows.map((r) => ({ ...r, ...countOf(r._id) }));
  // Library-wide totals (ignore the current filters) for the stat cards
  const allCount = await countsFor(libraryId, all.map((b) => b._id));
  const main = all.find((b) => b.isMain);
  const summary = {
    total: all.length,
    active: all.filter((b) => b.isActive).length,
    inactive: all.filter((b) => !b.isActive).length,
    mainName: main ? main.name : '',
    students: all.reduce((n, b) => n + allCount(b._id).studentCount, 0),
    seats: all.reduce((n, b) => n + allCount(b._id).seatCount, 0),
  };
  return {
    data, total, page: p, limit: l, totalPages: Math.max(1, Math.ceil(total / l)),
    summary, cities: cities.sort((x, y) => String(x).localeCompare(String(y))),
  };
};

exports.getBranch = async (id, libraryId) => {
  const b = await Branch.findOne({ _id: id, libraryId, isDeleted: false })
    .populate('managerId', 'name email mobile').lean();
  if (!b) return null;
  const countOf = await countsFor(libraryId, [b._id]);
  return { ...b, ...countOf(b._id) };
};

exports.createBranch = async (libraryId, body) => {
  const fields = pick(body, CREATE_FIELDS);
  if (!fields.name) throw fail('Branch name is required.', 400);
  await assertUniqueName(libraryId, fields.name);
  assertTimes(fields.openingTime || '06:00 AM', fields.closingTime || '11:00 PM');
  const managerId = await assertManager(body.managerId, libraryId);
  const existing = await Branch.countDocuments({ libraryId, isDeleted: false });
  if (existing >= 1) {
    // Second and later branches are a plan entitlement (feature 'multiBranch' + maxBranches limit)
    const ent = require('./entitlement.service');
    await ent.assertFeature(libraryId, 'multiBranch');
    await ent.enforceLimit('maxBranches', libraryId, 1);
  }
  return Branch.create({
    ...fields, libraryId, managerId,
    maxStudents: fields.maxStudents || 0, maxSeats: fields.maxSeats || 0,
    isMain: existing === 0,
  });
};

exports.updateBranch = async (id, libraryId, body) => {
  const update = pick(body, UPDATE_FIELDS);
  if (body.managerId !== undefined) update.managerId = await assertManager(body.managerId || null, libraryId);
  if (update.name) await assertUniqueName(libraryId, update.name, id);
  if (!Object.keys(update).length) throw fail('No valid fields to update.', 400);
  const cur = await Branch.findOne({ _id: id, libraryId, isDeleted: false }).select('isMain openingTime closingTime');
  if (!cur) throw fail('Branch not found.', 404);
  if (update.isActive === false && cur.isMain) {
    throw fail('The main branch cannot be deactivated. Make another branch the main one first.', 400);
  }
  assertTimes(update.openingTime ?? cur.openingTime, update.closingTime ?? cur.closingTime);
  const branch = await Branch.findOneAndUpdate(
    { _id: id, libraryId, isDeleted: false },
    { $set: update },
    { new: true, runValidators: true }
  );
  if (!branch) throw fail('Branch not found.', 404);
  return { branch, fields: Object.keys(update) };
};

exports.deleteBranch = async (id, libraryId) => {
  const branch = await Branch.findOne({ _id: id, libraryId, isDeleted: false });
  if (!branch) throw fail('Branch not found.', 404);
  if (branch.isMain) throw fail('Cannot delete the main branch.', 400);
  // Keep history intact: a branch that still has students must be emptied (moved) first
  const students = await Student.countDocuments({ libraryId, branchId: branch._id, isDeleted: false });
  if (students > 0) throw fail(`Branch still has ${students} student${students === 1 ? '' : 's'}. Move them to another branch first.`, 409);
  const seats = await Seat.countDocuments({ libraryId, branchId: branch._id, isDeleted: false });
  if (seats > 0) throw fail(`Branch still has ${seats} seat${seats === 1 ? '' : 's'}. Delete or move them first.`, 409);
  // Charges that still carry money to collect keep the branch alive (history of settled charges is kept)
  const openCharges = await Payment.countDocuments({ libraryId, branchId: branch._id, paymentStatus: { $in: ['partial', 'credit', 'overdue', 'pending'] }, dueAmount: { $gt: 0 } });
  if (openCharges > 0) throw fail(`Branch still has ${openCharges} unpaid charge${openCharges === 1 ? '' : 's'}. Settle or cancel them first.`, 409);
  branch.isDeleted = true;
  await branch.save();
  // Staff scoped to this branch lose that scope
  await Admin.updateMany({ libraryId, branchIds: branch._id }, { $pull: { branchIds: branch._id } });
  return branch;
};

exports.setMainBranch = async (id, libraryId) => {
  const branch = await Branch.findOne({ _id: id, libraryId, isDeleted: false });
  if (!branch) throw fail('Branch not found.', 404);
  if (!branch.isActive) throw fail('An inactive branch cannot be the main branch.', 400);
  await Branch.updateMany({ libraryId, _id: { $ne: branch._id } }, { $set: { isMain: false } });
  await Branch.updateOne({ _id: branch._id }, { $set: { isMain: true } });
  return branch.name;
};
