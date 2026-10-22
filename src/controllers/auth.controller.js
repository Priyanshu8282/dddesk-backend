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
const securityLog = require('../utils/securityLog');
const platformSettings = require('../services/platformSettings.service');

// During maintenance only super admins may sign in
const maintenanceBlock = async (res, userType) => {
  await platformSettings.ensureFresh();
  if (platformSettings.isMaintenance() && userType !== 'superadmin') {
    res.status(503).json({ success: false, code: 503, maintenance: true, message: platformSettings.maintenanceMessage() });
    return true;
  }
  return false;
};

// Why a sign-in failed, in words an investigator can filter on
const reasonOf = (err) => {
  if (err.libraryStatus) return 'library_blocked';
  if (err.status === 429) return 'otp_locked';
  if (err.status === 403) return 'account_disabled';
  if (err.status === 401) return 'invalid_credentials';
  if (err.status === 400) return 'invalid_otp';
  return 'error';
};
const { normalizeMobile } = require('../utils/mobile');

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
    if (await maintenanceBlock(res, result.userData.userType)) return;
    securityLog.record(req, { type: 'login', outcome: 'success', userId: result.userData.id, userType: result.userData.userType, libraryId: result.userData.libraryId?._id || result.userData.libraryId || null, meta: { method: 'password' } });
    return authSuccess(res, `Welcome back, ${result.userData.name}!`, result);
  } catch (err) {
    securityLog.record(req, { type: 'login', outcome: err.libraryStatus ? 'blocked' : 'failure', reason: reasonOf(err), meta: { method: 'password', status: err.status || null } });
    if (err.libraryStatus) return sendBlocked(res, err);
    return next(err);
  }
};

// Same response shape for every OTP flow (login + password reset, super admin / owner / staff / student).
// The OTP itself is included only while the service allows it (OTP_IN_RESPONSE / not production), so the UI can show it
// until an SMS/e-mail provider is configured. Unknown accounts get the identical shape without an `otp`.
const otpResponse = (res, message, { otp, isDev, channel, sentTo, expiresInSeconds }) => {
  const exposed = !!(isDev && otp);
  res.status(200).json({
    success: true,
    message,
    isOTP: true,
    channel: channel || null,
    sentTo: sentTo || null,
    expiresInSeconds: expiresInSeconds || 600,
    ...(exposed ? { otp, otpShownInResponse: true } : {}),
    data: { isOTP: true, channel: channel || null, sentTo: sentTo || null, expiresInSeconds: expiresInSeconds || 600, ...(exposed ? { otp } : {}) }
  });
};

exports.sendOTP = catchAsync(async (req, res) => {
  const r = await svc.sendOTP(req.body);
  securityLog.record(req, { type: 'otp_request', outcome: 'success', meta: { channel: r.channel || null } });
  otpResponse(res, 'If the number is registered, an OTP has been sent', r);
});

exports.verifyOTP = async (req, res, next) => {
  try {
    const result = await svc.verifyOTP(req.body);
    if (await maintenanceBlock(res, result.userData.userType)) return;
    securityLog.record(req, { type: 'login', outcome: 'success', userId: result.userData.id, userType: result.userData.userType, libraryId: result.userData.libraryId?._id || result.userData.libraryId || null, meta: { method: 'otp' } });
    return authSuccess(res, 'Login successful', result);
  } catch (err) {
    securityLog.record(req, { type: 'otp_verify', outcome: err.libraryStatus ? 'blocked' : 'failure', reason: reasonOf(err), meta: { status: err.status || null } });
    if (err.libraryStatus) return sendBlocked(res, err);
    return next(err);
  }
};

exports.forgotPassword = catchAsync(async (req, res) => {
  const r = await svc.forgotPassword(req.body);
  securityLog.record(req, { type: 'password_reset_request', outcome: 'success', meta: { channel: r.channel || null } });
  otpResponse(res, 'If the account exists, an OTP has been sent', r);
});

exports.verifyResetOTP = catchAsync(async (req, res) => {
  await svc.verifyResetOTP(req.body);
  res.status(200).json({ success: true, message: 'OTP verified successfully' });
});

exports.resetPassword = catchAsync(async (req, res) => {
  try {
    await svc.resetPassword(req.body);
  } catch (err) {
    securityLog.record(req, { type: 'password_reset', outcome: 'failure', reason: reasonOf(err) });
    throw err;
  }
  securityLog.record(req, { type: 'password_reset', outcome: 'success' });
  res.status(200).json({ success: true, message: 'Password reset successfully' });
});

exports.updateFcmToken = catchAsync(async (req, res) => {
  await svc.updateFcmToken(req.user._id, req.userType, req.body.fcmToken);
  res.status(200).json({ success: true, message: 'FCM Token updated successfully' });
});

exports.removeFcmToken = catchAsync(async (req, res) => {
  await svc.removeFcmToken(req.user._id, req.userType, req.body.fcmToken);
  res.status(200).json({ success: true, message: 'Device removed from notifications' });
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
    lastLogin: user.lastLogin || null,
    createdAt: user.createdAt || null,
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

const discardUpload = (file) => {
  if (!file?.path) return;
  try { fs.unlinkSync(path.resolve(file.path)); } catch (e) { /* ignore */ }
};

exports.updateProfile = catchAsync(async (req, res) => {
  const { name, mobile, currentPassword, newPassword } = req.body || {};
  const isStudent = req.userType === 'student';
  // Support access acts on the owner's behalf: it must never edit the owner's own profile
  if (req.impersonatedBy) { discardUpload(req.file); throw new ApiError(403, 'Not allowed while impersonating'); }

  const Model = isStudent ? Student : Admin;
  const user = await Model.findById(req.user._id).select('+password');
  if (!user) { discardUpload(req.file); throw new ApiError(404, 'User not found'); }

  const bcrypt = require('bcryptjs');
  const passwordOk = async () => !!currentPassword && (await bcrypt.compare(currentPassword, user.password));

  try {
    if (newPassword) {
      if (!(await passwordOk())) throw new ApiError(400, 'Current password is incorrect');
      user.password = newPassword; // hashed once by the model pre-save hook
    }

    // Mobile is a sign-in identifier (OTP login), so changing it needs the current password
    if (mobile !== undefined && !isStudent) {
      const next = normalizeMobile(mobile);
      if (next !== user.mobile) {
        if (!(await passwordOk())) throw new ApiError(400, 'Enter your current password to change your mobile number');
        const taken = await Admin.findOne({ mobile: next, _id: { $ne: user._id }, isDeleted: { $ne: true } }).select('_id');
        if (taken) throw new ApiError(409, 'This mobile number is already used by another account');
        user.mobile = next;
      }
    }

    if (name) user.name = name;

    if (req.file) {
      const isImage = req.file.mediaKind ? req.file.mediaKind === 'image' : /^image\//.test(req.file.mimetype || '');
      if (!isImage) throw new ApiError(400, 'Profile photo must be an image (JPG, PNG, WEBP or GIF)');
      const newRelativePath = req.file.path ? path.relative(process.cwd(), path.resolve(req.file.path)).replace(/\\/g, '/') : `uploads/profiles/${req.file.filename}`;
      if (user.profileImage && user.profileImage !== newRelativePath) removeFile(user.profileImage);
      user.profileImage = newRelativePath;
    }

    // validateModifiedOnly: older accounts may lack fields the schema now requires (e.g. mobile)
    await user.save({ validateModifiedOnly: true });
  } catch (e) {
    if (req.file && !(user.profileImage || '').endsWith(req.file.filename || '\0')) discardUpload(req.file);
    throw e;
  }
  if (newPassword) await audit(req, 'auth.password_change', isStudent ? 'Student' : 'Admin', user._id);
  else await audit(req, 'auth.profile_update', isStudent ? 'Student' : 'Admin', user._id, { fields: [name && 'name', mobile !== undefined && 'mobile', req.file && 'profileImage'].filter(Boolean) });

  const userData = {
    id: user._id,
    name: user.name,
    email: user.email,
    mobile: user.mobile,
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
  if (req.impersonatedBy) throw new ApiError(403, 'Not allowed while impersonating');
  const Model = req.userType === 'student' ? Student : Admin;
  const user = await Model.findById(req.user._id);
  if (user?.profileImage) {
    removeFile(user.profileImage);
    user.profileImage = null;
    await user.save({ validateModifiedOnly: true });
    await audit(req, 'auth.profile_image_removed', req.userType === 'student' ? 'Student' : 'Admin', user._id);
  }
  res.status(200).json({
    success: true,
    message: 'Profile image removed successfully',
    data: { profileImage: null }
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
