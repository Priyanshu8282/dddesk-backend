const catchAsync = require('../utils/catchAsync');
const ApiError   = require('../utils/ApiError');
const fs   = require('fs');
const path = require('path');
const Admin = require('../models/admin.model');
const mongoose = require('mongoose');
const Library = require('../models/library.model');
const svc = require('../services/auth.service');

exports.login = catchAsync(async (req, res) => {
  const { token, userData, role } = await svc.login(req.body);
  const message = `Welcome back, ${userData.name}!`;
  res.status(200).json({
    success: true,
    message,
    token,
    user: userData,
    data: { token, user: userData },
    [role]: userData
  });
});

exports.sendOTP = catchAsync(async (req, res) => {
  const { otp, isDev } = await svc.sendOTP(req.body);
  res.status(200).json({
    success: true,
    message: 'OTP sent successfully',
    data: { isOTP: true, ...(isDev && { otp }) },
    ...(isDev && { otp }),
    isOTP: true
  });
});

exports.verifyOTP = catchAsync(async (req, res) => {
  const { token, userData, role } = await svc.verifyOTP(req.body);
  res.status(200).json({
    success: true,
    message: 'Login successful',
    token,
    user: userData,
    data: { token, user: userData },
    [role]: userData
  });
});

exports.forgotPassword = catchAsync(async (req, res) => {
  const { email } = req.body;
  if (!email) throw new ApiError(400, 'Email is required');
  const { otp, isDev } = await svc.forgotPassword(email);
  res.status(200).json({
    success: true,
    message: 'OTP sent to your email successfully',
    data: { isOTP: true, ...(isDev && { otp }) },
    ...(isDev && { otp }),
    isOTP: true
  });
});

exports.verifyResetOTP = catchAsync(async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) throw new ApiError(400, 'Email and OTP are required');
  await svc.verifyResetOTP(email, otp);
  res.status(200).json({
    success: true,
    message: 'OTP verified successfully'
  });
});

exports.resetPassword = catchAsync(async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    throw new ApiError(400, 'Email, OTP, and New Password are required');
  await svc.resetPassword(email, otp, newPassword);
  res.status(200).json({
    success: true,
    message: 'Password reset successfully'
  });
});

exports.updateFcmToken = catchAsync(async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) throw new ApiError(400, 'FCM Token is required');
  await svc.updateFcmToken(req.user._id, req.user.userType, fcmToken);
  res.status(200).json({
    success: true,
    message: 'FCM Token updated successfully'
  });
});

exports.getMe = catchAsync(async (req, res) => {
  const user = req.user;
  const profileData = {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.roleId?.name,
    libraryId: user.libraryId?._id || user.libraryId,
    profileImage: user.profileImage,
    userType: req.userType,
    status: user.status,
    permissions: req.permissions,
  };

  res.status(200).json({
    success: true,
    message: 'Profile retrieved successfully',
    data: profileData,
    ...profileData
  });
});

exports.updateProfile = catchAsync(async (req, res) => {
  const { name, newPassword } = req.body || {};
  const user = await Admin.findById(req.user._id);
  if (name) user.name = name;
  if (req.file) {
    if (user.profileImage) {
      const old = path.join(__dirname, '../../', user.profileImage);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
    user.profileImage = `uploads/profiles/${req.file.filename}`;
  }
  if (newPassword) {
    const bcrypt = require('bcryptjs');
    user.password = await bcrypt.hash(newPassword, 10);
  }
  await user.save();
  const userData = {
    id: user._id,
    name: user.name,
    email: user.email,
    profileImage: user.profileImage,
    userType: req.user.userType,
    status: user.status
  };
  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    data: userData,
    user: userData
  });
});

exports.deleteProfileImage = catchAsync(async (req, res) => {
  const user = await Admin.findById(req.user._id);
  if (user.profileImage) {
    const p = path.join(__dirname, '../../', user.profileImage);
    if (fs.existsSync(p)) fs.unlinkSync(p);
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
      const img = field === 'logo' ? library.logo : library.photos[parseInt(index)];
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
