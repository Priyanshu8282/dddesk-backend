const Branch = require('./branch.model');

exports.listBranches = async (libraryId, { search = '', page = 1, limit = 50, isActive } = {}) => {
  const filter = { libraryId, isDeleted: false };
  if (search) filter.name = { $regex: search, $options: 'i' };
  if (isActive !== undefined) filter.isActive = String(isActive) === 'true';
  const skip = (Number(page) - 1) * Number(limit);
  const [data, total] = await Promise.all([
    Branch.find(filter)
      .populate('managerId', 'name email mobile')
      .sort({ isMain: -1, createdAt: 1 })
      .skip(skip).limit(Number(limit)).lean(),
    Branch.countDocuments(filter),
  ]);
  return { data, total, page: Number(page), limit: Number(limit) };
};

exports.getBranch = async (id, libraryId) =>
  Branch.findOne({ _id: id, libraryId, isDeleted: false })
    .populate('managerId', 'name email mobile').lean();

exports.createBranch = async (libraryId, body) => {
  const { name, address, city, state, pincode, mobile, email, managerId,
          openingTime, closingTime, maxStudents, maxSeats, notes } = body;
  if (!name) { const e = new Error('Branch name is required.'); e.status = 400; throw e; }
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
  FIELDS.forEach(k => {
    if (body[k] !== undefined) update[k] = k === 'managerId' ? (body[k] || null) : body[k];
  });
  const branch = await Branch.findOneAndUpdate(
    { _id: id, libraryId, isDeleted: false },
    { $set: update },
    { new: true, runValidators: true }
  );
  if (!branch) { const e = new Error('Branch not found.'); e.status = 404; throw e; }
  return branch;
};

exports.deleteBranch = async (id, libraryId) => {
  const branch = await Branch.findOne({ _id: id, libraryId, isDeleted: false });
  if (!branch) { const e = new Error('Branch not found.'); e.status = 404; throw e; }
  if (branch.isMain) { const e = new Error('Cannot delete the main branch.'); e.status = 400; throw e; }
  branch.isDeleted = true;
  await branch.save();
};

exports.setMainBranch = async (id, libraryId) => {
  const branch = await Branch.findOne({ _id: id, libraryId, isDeleted: false });
  if (!branch) { const e = new Error('Branch not found.'); e.status = 404; throw e; }
  await Branch.updateMany({ libraryId }, { $set: { isMain: false } });
  branch.isMain = true;
  await branch.save();
  return branch.name;
};
