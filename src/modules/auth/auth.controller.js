const catchAsync = require('../../utils/catchAsync');
const fs   = require('fs');
const path = require('path');
const Admin = require('../admins/admin.model');
const mongoose = require('mongoose');
const Library = require('../libraries/library.model');
const svc = require('../../services/auth.service');

exports.login = catchAsync(async (req, res) => {
  const { token, userData, role } = await svc.login(req.body);
  const message = `Welcome back, ${userData.name}!`;
  res.json({ success: true, message, token, user: userData, [role]: userData });
});

exports.sendOTP = catchAsync(async (req, res) => {
  const { otp, isDev } = await svc.sendOTP(req.body);
  res.json({ success: true, message: 'OTP sent successfully', ...(isDev && { otp }), isOTP: true });
});

exports.verifyOTP = catchAsync(async (req, res) => {
  const { token, userData, role } = await svc.verifyOTP(req.body);
  res.json({ success: true, message: 'Login successful', token, user: userData, [role]: userData });
});

exports.forgotPassword = catchAsync(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
  const { otp, isDev } = await svc.forgotPassword(email);
  res.json({ success: true, message: 'OTP sent to your email successfully', ...(isDev && { otp }), isOTP: true });
});

exports.verifyResetOTP = catchAsync(async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and OTP are required' });
  await svc.verifyResetOTP(email, otp);
  res.json({ success: true, message: 'OTP verified successfully' });
});

exports.resetPassword = catchAsync(async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    return res.status(400).json({ success: false, message: 'Email, OTP, and New Password are required' });
  await svc.resetPassword(email, otp, newPassword);
  res.json({ success: true, message: 'Password reset successfully' });
});

exports.updateFcmToken = catchAsync(async (req, res) => {
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ success: false, message: 'FCM Token is required' });
  await svc.updateFcmToken(req.user._id, req.user.userType, fcmToken);
  res.json({ success: true, message: 'FCM Token updated successfully' });
});

exports.getMe = catchAsync(async (req, res) => {
  const user = req.user;
  res.json({
    id: user._id, name: user.name, email: user.email,
    role: user.roleId?.name,
    libraryId: user.libraryId?._id || user.libraryId,
    profileImage: user.profileImage,
    userType: req.userType,
    status: user.status,
    permissions: req.permissions,
  });
});

exports.updateProfile = catchAsync(async (req, res) => {
  const { name, newPassword } = req.body || {};
  const user = await Admin.findById(req.user._id);
  if (name) user.name = name;
  if (req.file) {
    if (user.profileImage) {
      const old = path.join(__dirname, '../../../', user.profileImage);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
    user.profileImage = `uploads/profiles/${req.file.filename}`;
  }
  if (newPassword) {
    const bcrypt = require('bcryptjs');
    user.password = await bcrypt.hash(newPassword, 10);
  }
  await user.save();
  res.json({ message: 'Profile updated successfully', user: { id: user._id, name: user.name, email: user.email, profileImage: user.profileImage, userType: req.user.userType, status: user.status } });
});

exports.deleteProfileImage = catchAsync(async (req, res) => {
  const user = await Admin.findById(req.user._id);
  if (user.profileImage) {
    const p = path.join(__dirname, '../../../', user.profileImage);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    user.profileImage = null;
    await user.save();
  }
  res.json({ message: 'Profile image deleted successfully' });
});

exports.getPublicProfileImage = async (req, res) => {
  try {
    const { id } = req.params;
    const { field, index } = req.query;
    const defaultPath = path.join(__dirname, '../../../uploads/profiles/default-avatar.png');

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
