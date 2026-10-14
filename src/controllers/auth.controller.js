const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const fs   = require('fs');
const path = require('path');
const Admin = require('../models/admin.model');
const Student = require('../models/student.model');
const mongoose = require('mongoose');
const Library = require('../models/library.model');
const svc = require('../services/auth.service');
const audit = require('../utils/audit');

// Library not usable (pending / rejected / suspended): 403 with libraryStatus so the frontend can show it
const sendBlocked = (res, err) =>
  res.status(403).json({
    success: false, code: 403, message: err.message,
    libraryStatus: err.libraryStatus, statusReason: err.statusReason || null,
  });

const authSuccess = (res, message, { token, userData, role }) =>
  res.status(200).json({
    success: true,
    message,
    token,
    user: userData,
    data: { token, user: userData },
    [role]: userData
  });

exports.login = async (req, res, next) => {
  try {
    const result = await svc.login(req.body);
    return authSuccess(res, `Welcome back, ${result.userData.name}!`, result);
  } catch (err) {
    if (err.libraryStatus) return sendBlocked(res, err);
    return next(err);
  }
};

// OTP is returned ONLY when NODE_ENV === 'development' (there is no delivery provider wired yet)
const otpResponse = (res, message, { otp, isDev }) =>
  res.status(200).json({
    success: true,
    message,
    data: { isOTP: true, ...(isDev && otp ? { otp } : {}) },
    ...(isDev && otp ? { otp } : {}),
    isOTP: true
  });

exports.sendOTP = catchAsync(async (req, res) => {
  const r = await svc.sendOTP(req.body);
  otpResponse(res, 'If the number is registered, an OTP has been sent', r);
});

exports.verifyOTP = async (req, res, next) => {
  try {
    const result = await svc.verifyOTP(req.body);
    return authSuccess(res, 'Login successful', result);
  } catch (err) {
    if (err.libraryStatus) return sendBlocked(res, err);
    return next(err);
  }
};

exports.forgotPassword = catchAsync(async (req, res) => {
  const r = await svc.forgotPassword(req.body);
  otpResponse(res, 'If the account exists, an OTP has been sent', r);
});

exports.verifyResetOTP = catchAsync(async (req, res) => {
  await svc.verifyResetOTP(req.body);
  res.status(200).json({ success: true, message: 'OTP verified successfully' });
});

exports.resetPassword = catchAsync(async (req, res) => {
  await svc.resetPassword(req.body);
  res.status(200).json({ success: true, message: 'Password reset successfully' });
});

exports.updateFcmToken = catchAsync(async (req, res) => {
  await svc.updateFcmToken(req.user._id, req.userType, req.body.fcmToken);
  res.status(200).json({ success: true, message: 'FCM Token updated successfully' });
});

exports.getMe = catchAsync(async (req, res) => {
  const user = req.user;
  const lib = req.library;
  const profileData = {
    id: user._id,
    name: user.name,
    email: user.email,
    mobile: user.mobile,
    role: user.roleId?.name,
    libraryId: req.libraryId || null,
    library: lib ? { id: lib._id, name: lib.name, slug: lib.slug || null, status: lib.status, statusReason: lib.statusReason || null, logo: lib.logo || null } : null,
    branchIds: user.branchIds || [],
    profileImage: user.profileImage,
    userType: req.userType,
    status: user.status,
    permissions: req.permissions,
    impersonatedBy: req.impersonatedBy || null,
  };

  res.status(200).json({
    success: true,
    message: 'Profile retrieved successfully',
    data: profileData,
    ...profileData
  });
});

const removeFile = (rel) => {
  if (!rel || rel.includes('default-avatar')) return;
  const abs = path.resolve(process.cwd(), rel);
  // only delete inside the uploads directory
  if (!abs.startsWith(path.resolve(process.cwd(), 'uploads') + path.sep)) return;
  if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch (e) { /* ignore */ } }
};

exports.updateProfile = catchAsync(async (req, res) => {
  const { name, currentPassword, newPassword } = req.body || {};
  const isStudent = req.userType === 'student';
  const Model = isStudent ? Student : Admin;
  const user = await Model.findById(req.user._id).select('+password');
  if (!user) throw new ApiError(404, 'User not found');

  if (newPassword) {
    if (req.impersonatedBy) throw new ApiError(403, 'Not allowed while impersonating');
    const bcrypt = require('bcryptjs');
    if (!currentPassword || !(await bcrypt.compare(currentPassword, user.password))) {
      throw new ApiError(400, 'Current password is incorrect');
    }
    user.password = newPassword; // hashed once by the model pre-save hook
  }
  if (name) user.name = name;
  if (req.file) {
    const newRelativePath = req.file.path ? path.relative(process.cwd(), path.resolve(req.file.path)).replace(/\\/g, '/') : `uploads/profiles/${req.file.filename}`;
    if (user.profileImage && user.profileImage !== newRelativePath) removeFile(user.profileImage);
    user.profileImage = newRelativePath;
  }
  await user.save();
  if (newPassword) await audit(req, 'auth.password_change', isStudent ? 'Student' : 'Admin', user._id);

  const userData = {
    id: user._id,
    name: user.name,
    email: user.email,
    profileImage: user.profileImage,
    userType: req.userType,
    status: user.status
  };
  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    data: userData,
    user: userData
  });
});

exports.changePassword = catchAsync(async (req, res) => {
  if (req.impersonatedBy) throw new ApiError(403, 'Not allowed while impersonating');
  await svc.changePassword(req.user._id, req.userType, req.body.currentPassword, req.body.newPassword);
  await audit(req, 'auth.password_change', req.userType === 'student' ? 'Student' : 'Admin', req.user._id);
  res.status(200).json({ success: true, message: 'Password updated successfully' });
});

exports.deleteProfileImage = catchAsync(async (req, res) => {
  const Model = req.userType === 'student' ? Student : Admin;
  const user = await Model.findById(req.user._id);
  if (user?.profileImage) {
    removeFile(user.profileImage);
    user.profileImage = null;
    await user.save();
  }
  res.status(200).json({
    success: true,
    message: 'Profile image deleted successfully'
  });
});

exports.getPublicProfileImage = async (req, res) => {
  try {
    const { id } = req.params;
    const { field, index } = req.query;
    const defaultPath = path.join(__dirname, '../../uploads/profiles/default-avatar.png');

    const fallback = (name = 'User') => {
      if (fs.existsSync(defaultPath)) return res.sendFile(defaultPath);
      return res.redirect(`https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=4f46e5&color=fff&size=256&bold=true`);
    };

    if (id === 'default') return fallback('Admin');
    if (!mongoose.Types.ObjectId.isValid(id)) return fallback('Admin');

    if (field === 'logo' || field === 'photos') {
      let library = await Library.findById(id);
      if (!library) {
        const admin = await Admin.findById(id);
        if (admin?.libraryId) library = await Library.findById(admin.libraryId);
      }
      if (!library) return fallback('Library');
      const img = field === 'logo' ? library.logo : library.photos[parseInt(index, 10)];
      if (!img) return fallback(library.name);
      const p = path.resolve(process.cwd(), img);
      return fs.existsSync(p) ? res.sendFile(p, err => { if (err && !res.headersSent) fallback(library.name); }) : fallback(library.name);
    }

    const user = await Admin.findById(id);
    if (!user?.profileImage || user.profileImage.includes('default-avatar.png')) return fallback(user?.name);
    const p = path.resolve(process.cwd(), user.profileImage);
    return fs.existsSync(p) ? res.sendFile(p, err => { if (err && !res.headersSent) fallback(user.name); }) : fallback(user.name);
  } catch (_) {
    return res.redirect('https://ui-avatars.com/api/?name=User&background=4f46e5&color=fff&size=256&bold=true');
  }
};
