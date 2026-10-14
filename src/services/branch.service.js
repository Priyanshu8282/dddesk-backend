const Branch = require('../models/branch.model');
const Admin = require('../models/admin.model');
const Student = require('../models/student.model');
const Seat = require('../models/seat.model');
const Payment = require('../models/payment.model');
const pick = require('../utils/pick');
const escapeRegex = require('../utils/escapeRegex');

const fail = (message, status) => Object.assign(new Error(message), { status });

const CREATE_FIELDS = ['name', 'address', 'city', 'state', 'pincode', 'mobile', 'email', 'openingTime', 'closingTime', 'maxStudents', 'maxSeats', 'notes'];
const UPDATE_FIELDS = [...CREATE_FIELDS, 'isActive'];

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

exports.listBranches = async (libraryId, { search = '', page = 1, limit = 50, isActive } = {}) => {
  const filter = { libraryId, isDeleted: false };
  if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };
  if (isActive !== undefined) filter.isActive = String(isActive) === 'true';
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(200, Math.max(1, Number(limit) || 50));
  const [data, total] = await Promise.all([
    Branch.find(filter)
      .populate('managerId', 'name email mobile')
      .sort({ isMain: -1, createdAt: 1 })
      .skip((p - 1) * l).limit(l).lean(),
    Branch.countDocuments(filter),
  ]);
  return { data, total, page: p, limit: l };
};

exports.getBranch = async (id, libraryId) =>
  Branch.findOne({ _id: id, libraryId, isDeleted: false })
    .populate('managerId', 'name email mobile').lean();

exports.createBranch = async (libraryId, body) => {
  const fields = pick(body, CREATE_FIELDS);
  if (!fields.name) throw fail('Branch name is required.', 400);
  await assertUniqueName(libraryId, fields.name);
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
