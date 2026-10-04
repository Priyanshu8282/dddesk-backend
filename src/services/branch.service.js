const Branch = require('../modules/branches/branch.model');

const err = (msg, status) => Object.assign(new Error(msg), { status });

exports.listBranches = async (libraryId, { search = '', page = 1, limit = 50, isActive } = {}) => {
  const filter = { libraryId, isDeleted: false };
  if (search) filter.name = { $regex: search, $options: 'i' };
  if (isActive !== undefined) filter.isActive = String(isActive) === 'true';
  const skip = (Number(page) - 1) * Number(limit);
  const [data, total] = await Promise.all([
    Branch.find(filter).populate('managerId','name email mobile')
      .sort({ isMain: -1, createdAt: 1 }).skip(skip).limit(Number(limit)).lean(),
    Branch.countDocuments(filter),
  ]);
  return { data, total, page: Number(page), limit: Number(limit) };
};

exports.getBranch = async (id, libraryId) =>
  Branch.findOne({ _id: id, libraryId, isDeleted: false })
    .populate('managerId','name email mobile').lean();

exports.createBranch = async (libraryId, body) => {
  const { name, address, city, state, pincode, mobile, email, managerId,
          openingTime, closingTime, maxStudents, maxSeats, notes } = body;
  if (!name) throw err('Branch name is required.', 400);
  const existing = await Branch.countDocuments({ libraryId, isDeleted: false });
  return Branch.create({
    libraryId, name, address, city, state, pincode, mobile, email,
    managerId: managerId || null, openingTime, closingTime,
    maxStudents: maxStudents || 0, maxSeats: maxSeats || 0,
    notes, isMain: existing === 0,
  });
};

exports.updateBranch = async (id, libraryId, body) => {
  const FIELDS = ['name','address','city','state','pincode','mobile','email',
                  'managerId','isActive','openingTime','closingTime','maxStudents','maxSeats','notes'];
  const update = {};
  FIELDS.forEach(k => { if (body[k] !== undefined) update[k] = k === 'managerId' ? (body[k] || null) : body[k]; });
  const branch = await Branch.findOneAndUpdate(
    { _id: id, libraryId, isDeleted: false }, { $set: update }, { new: true, runValidators: true }
  );
  if (!branch) throw err('Branch not found.', 404);
  return branch;
};

exports.deleteBranch = async (id, libraryId) => {
  const branch = await Branch.findOne({ _id: id, libraryId, isDeleted: false });
  if (!branch) throw err('Branch not found.', 404);
  if (branch.isMain) throw err('Cannot delete the main branch.', 400);
  branch.isDeleted = true;
  await branch.save();
};

exports.setMainBranch = async (id, libraryId) => {
  const branch = await Branch.findOne({ _id: id, libraryId, isDeleted: false });
  if (!branch) throw err('Branch not found.', 404);
  await Branch.updateMany({ libraryId }, { $set: { isMain: false } });
  branch.isMain = true;
  await branch.save();
  return branch.name;
};
