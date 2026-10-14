const Admin   = require('../models/admin.model');
const Library = require('../models/library.model');
const Role    = require('../models/role.model');

// ── Staff / Employee ──────────────────────────────────────────────────────────

exports.createStaff = async (body, files, requestingUser) => {
  let { name, email, password, roleId, libraryId, mobile,
        alternativeMobileNumber, joiningDate, documentNames,
        address, city, state, country, pincode } = body;

  if (await Admin.findOne({ email })) throw Object.assign(new Error('Email already exists'), { status: 400 });

  if (requestingUser.userType === 'admin' || requestingUser.libraryId) {
    libraryId = requestingUser.libraryId;
    if (!roleId) {
      const staffRole = await Role.findOne({ name: 'Staff' });
      if (!staffRole) throw Object.assign(new Error("System Error: 'Staff' role is missing."), { status: 500 });
      roleId = staffRole._id;
    }
  }

  let profileImage = '';
  if (Array.isArray(files)) {
    const f = files.find(f => f.fieldname === 'profileImage');
    if (f) profileImage = f.path;
  }

  let documents = [];
  if (documentNames) {
    try {
      const names = JSON.parse(documentNames);
      if (Array.isArray(names)) {
        documents = names.map((docName, i) => {
          const docFile = Array.isArray(files) ? files.find(f => f.fieldname === `docFile_${i}`) : null;
          return { name: docName, files: docFile ? [docFile.path] : [] };
        });
      }
    } catch (_) {}
  }

  return Admin.create({
    name, email, password, userType: 'staff', roleId, libraryId,
    mobile, alternativeMobileNumber, joiningDate,
    address, city, state, country, pincode,
    documents, profileImage, createdBy: requestingUser._id,
  });
};

exports.createLibraryWithAdmin = async (input, files, requestingUser) => {
  if (await Admin.findOne({ email: input.email }))
    throw Object.assign(new Error('Admin with this email already exists'), { status: 400 });

  if (typeof input.settings     === 'string') { try { input.settings     = JSON.parse(input.settings);     } catch (_) {} }
  if (typeof input.workingHours === 'string') { try { input.workingHours = JSON.parse(input.workingHours); } catch (_) {} }

  let roleId = input.roleId;
  if (!roleId) {
    const adminRole = await Role.findOne({ name: 'Admin' });
    if (!adminRole) throw Object.assign(new Error("System Error: 'Admin' role missing."), { status: 500 });
    roleId = adminRole._id;
  }

  let profileImage = '', logo = '', photos = [];
  if (Array.isArray(files)) {
    const pf = files.find(f => f.fieldname === 'profileImage');
    const lf = files.find(f => f.fieldname === 'logo');
    const ph = files.filter(f => f.fieldname === 'photos');
    if (pf) profileImage = pf.path;
    if (lf) logo = lf.path;
    if (ph.length) photos = ph.map(f => f.path);
  } else if (files) {
    if (files.profileImage) profileImage = files.profileImage[0].path;
    if (files.logo)         logo         = files.logo[0].path;
    if (files.photos)       photos        = files.photos.map(f => f.path);
  }

  const library = await new Library({
    name: input.name, ownerName: input.ownerName, mobile: input.mobile,
    alternativeMobileNumber: input.alternativeMobileNumber, email: input.email,
    password: input.password, roleId,
    address: input.address, city: input.city, state: input.state,
    country: input.country, pincode: input.pincode,
    logo, photos, settings: input.settings, workingHours: input.workingHours,
    createdBy: requestingUser ? 'SUPER_ADMIN' : 'SELF',
    createdById: requestingUser?._id ?? null,
  }).save();

  const admin = await Admin.create({
    name: input.ownerName, email: input.email, password: input.password,
    userType: 'admin', roleId, libraryId: library._id,
    mobile: input.mobile, alternativeMobileNumber: input.alternativeMobileNumber,
    address: input.address, city: input.city, state: input.state,
    country: input.country, pincode: input.pincode,
    profileImage, createdBy: requestingUser?._id ?? null,
  });

  return { library, admin };
};

exports.listStaff = async (query, requestingUser) => {
  const { page = 1, limit = 10, search = '', userType = 'staff', status = '', libraryId = '' } = query;
  const filter = { isDeleted: false };
  if (userType !== 'all') filter.userType = userType;

  if (requestingUser.userType === 'admin' || requestingUser.libraryId)
    filter.libraryId = requestingUser.libraryId;
  else if (libraryId) filter.libraryId = libraryId;

  if (status === 'active') filter.status = true;
  else if (status === 'inactive') filter.status = false;

  if (search) filter.$or = [
    { name:   { $regex: search, $options: 'i' } },
    { email:  { $regex: search, $options: 'i' } },
    { mobile: { $regex: search, $options: 'i' } },
  ];

  const p = parseInt(page), l = parseInt(limit);
  const [data, total] = await Promise.all([
    Admin.find(filter).populate('roleId','name').populate('libraryId','name')
      .sort({ createdAt: -1 }).skip((p-1)*l).limit(l),
    Admin.countDocuments(filter),
  ]);

  const summaryBase = { isDeleted: false, userType: filter.userType };
  if (filter.libraryId) summaryBase.libraryId = filter.libraryId;
  const [totalCount, activeCount, inactiveCount] = await Promise.all([
    Admin.countDocuments(summaryBase),
    Admin.countDocuments({ ...summaryBase, status: true }),
    Admin.countDocuments({ ...summaryBase, status: false }),
  ]);

  return { data, total, page: p, limit: l, totalPages: Math.ceil(total/l), summary: { total: totalCount, active: activeCount, inactive: inactiveCount } };
};

exports.getAdminById = async (id) =>
  Admin.findById(id).populate('roleId','name').populate('libraryId');

exports.updateAdmin = async (id, body, files, requestingUser) => {
  let updateData = { ...body };
  const isSelf = !body._targetId || id.toString() === requestingUser._id.toString();

  if (!isSelf && requestingUser.userType === 'admin') {
    if (!updateData.roleId) {
      const staffRole = await Role.findOne({ name: 'Staff' });
      if (staffRole) updateData.roleId = staffRole._id;
    }
    updateData.libraryId = requestingUser.libraryId;
  } else if (isSelf) {
    delete updateData.roleId; delete updateData.libraryId;
    delete updateData.userType; delete updateData.status; delete updateData.isDeleted;
  }

  if (typeof updateData.settings     === 'string') { try { updateData.settings     = JSON.parse(updateData.settings);     } catch (_) {} }
  if (typeof updateData.workingHours === 'string') { try { updateData.workingHours = JSON.parse(updateData.workingHours); } catch (_) {} }

  if (updateData.documentNames) {
    const names = JSON.parse(updateData.documentNames);
    const admin = await Admin.findById(id);
    if (admin) {
      updateData.documents = names.map((docName, i) => {
        const docFile = Array.isArray(files) ? files.find(f => f.fieldname === `docFile_${i}`) : null;
        if (docFile) return { name: docName, files: [docFile.path] };
        return admin.documents.find(d => d.name === docName) || { name: docName, files: [] };
      });
    }
  }

  if (files) {
    let pf, lf, ph = [];
    if (Array.isArray(files)) {
      pf = files.find(f => f.fieldname === 'profileImage');
      lf = files.find(f => f.fieldname === 'logo');
      ph = files.filter(f => f.fieldname === 'photos').map(f => f.path);
    } else {
      if (files.profileImage) pf = files.profileImage[0];
      if (files.logo)         lf = files.logo[0];
      if (files.photos)       ph = files.photos.map(f => f.path);
    }
    if (pf) updateData.profileImage = pf.path;
    if (lf) updateData.logo = lf.path;
    if (ph.length) updateData.photos = ph;
  }

  if (updateData.existingPhotos) {
    try {
      const existing = JSON.parse(updateData.existingPhotos);
      updateData.photos = updateData.photos ? [...existing, ...updateData.photos] : existing;
    } catch (_) {}
  }

  const NULL_VALS = ['null', '', 'REMOVE_IMAGE', 'uploads/profiles/default-avatar.png'];
  if (NULL_VALS.includes(updateData.profileImage)) updateData.profileImage = null;
  if (['null','','REMOVE_IMAGE'].includes(updateData.logo)) updateData.logo = null;

  const updated = await Admin.findByIdAndUpdate(id, { ...updateData, updatedBy: requestingUser._id }, { new: true });
  if (!updated) throw Object.assign(new Error('User not found'), { status: 404 });

  if (updated.userType === 'admin' && updated.libraryId) {
    const libUpdate = {};
    ['name','ownerName','mobile','alternativeMobileNumber','email','address','city','state','country','pincode','logo','photos','settings','workingHours','website','gstNumber']
      .forEach(k => { if (body[k] !== undefined) libUpdate[k] = body[k]; });
    if (Object.keys(libUpdate).length) {
      const libId = updated.libraryId._id || updated.libraryId;
      await Library.findByIdAndUpdate(libId, libUpdate);
    }
  }

  return Admin.findById(updated._id).populate('roleId','name').populate('libraryId');
};

exports.updateStatus = async (id, status, updatedBy) => {
  const adminStatus = status === 'active' ? true : status === 'inactive' ? false : status;
  const admin = await Admin.findByIdAndUpdate(id, { status: adminStatus, updatedBy }, { new: true }).populate('libraryId');
  if (!admin) throw Object.assign(new Error('User not found'), { status: 404 });
  if (admin.userType === 'admin' && admin.libraryId) {
    const libId = admin.libraryId._id || admin.libraryId;
    await Library.findByIdAndUpdate(libId, { status: adminStatus ? 'active' : 'inactive' });
  }
  return admin;
};

exports.softDelete = async (id, requestingUserId) => {
  if (id === requestingUserId.toString()) throw Object.assign(new Error('Cannot delete your own account'), { status: 400 });
  const admin = await Admin.findByIdAndUpdate(id, { isDeleted: true });
  if (!admin) throw Object.assign(new Error('User not found'), { status: 404 });
};

exports.changePassword = async (userId, newPassword) => {
  const admin = await Admin.findById(userId);
  if (!admin) throw Object.assign(new Error('User not found'), { status: 404 });
  admin.password = newPassword;
  await admin.save();
  if (admin.userType === 'admin' && admin.libraryId) {
    const libId = admin.libraryId._id || admin.libraryId;
    await Library.findByIdAndUpdate(libId, { password: newPassword });
  }
};
