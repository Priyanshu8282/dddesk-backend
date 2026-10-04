const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Admin   = require('../modules/admins/admin.model');
const Student = require('../modules/students/student.model');
const config  = require('../config/config');

const pickModel = (role) => role === 'STUDENT' ? Student : Admin;

const buildToken = (user, role) =>
  jwt.sign(
    { id: user._id, email: user.email, type: role === 'ADMIN' ? (user.userType || 'admin') : 'student' },
    config.jwt.secret,
    { expiresIn: config.jwt.expiration }
  );

const buildUserData = (user, role) => {
  const permissions = user.roleId?.permissionIds?.map(p => p.key) || [];
  const data = {
    id: user._id, name: user.name, email: user.email, mobile: user.mobile,
    profileImage: user.profileImage,
    userType: role === 'ADMIN' ? (user.userType || 'admin') : 'student',
    permissions, fcmTokens: user.fcmTokens || [],
  };
  data.role      = role === 'ADMIN' ? user.roleId?.name : undefined;
  data.libraryId = role === 'ADMIN' ? user.libraryId : (user.libraryId?._id || user.libraryId);
  return data;
};

const appendFcmToken = async (user, fcmToken) => {
  if (!fcmToken) return;
  if (!user.fcmTokens) user.fcmTokens = [];
  if (!user.fcmTokens.includes(fcmToken)) {
    user.fcmTokens.push(fcmToken);
    user.markModified('fcmTokens');
    await user.save();
  }
};

const err = (msg, status) => Object.assign(new Error(msg), { status });

exports.login = async ({ identifier, email, mobile, password, userRole, fcmToken }) => {
  const role  = userRole === 'STUDENT' ? 'STUDENT' : 'ADMIN';
  const Model = pickModel(role);
  const loginEmail  = email  || (identifier?.includes('@') ? identifier : '');
  const loginMobile = mobile || (!identifier?.includes('@') ? identifier : '');
  if (!loginEmail && !loginMobile) throw err('Email or Mobile is required', 400);

  let query = {};
  if (loginEmail && loginMobile) query = { $or: [{ email: loginEmail }, { mobile: loginMobile }] };
  else if (loginEmail)  query = { email: loginEmail };
  else query = { mobile: loginMobile };

  const user = await Model.findOne({ ...query, isDeleted: { $ne: true } })
    .populate(role === 'ADMIN' ? { path: 'roleId', populate: { path: 'permissionIds' } } : 'libraryId');

  if (!user) throw err(loginMobile && !loginEmail ? 'Mobile number not found' : 'Email address not found', 401);
  if (!await bcrypt.compare(password, user.password)) throw err('Incorrect password', 401);
  if (role === 'STUDENT' && user.status !== 'active') throw err('Account is inactive', 403);

  await appendFcmToken(user, fcmToken);
  return { token: buildToken(user, role), userData: buildUserData(user, role), role: role.toLowerCase() };
};

exports.sendOTP = async ({ mobile, userRole }) => {
  const Model = pickModel(userRole === 'STUDENT' ? 'STUDENT' : 'ADMIN');
  const user  = await Model.findOne({ mobile });
  if (!user) throw err('Mobile number not found', 404);
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  user.otp = otp;
  await user.save();
  return { otp, isDev: process.env.NODE_ENV === 'development' };
};

exports.verifyOTP = async ({ mobile, otp, userRole, fcmToken }) => {
  const role  = userRole === 'STUDENT' ? 'STUDENT' : 'ADMIN';
  const Model = pickModel(role);
  const user  = await Model.findOne({ mobile })
    .populate(role === 'ADMIN' ? { path: 'roleId', populate: { path: 'permissionIds' } } : 'libraryId');
  if (!user) throw err('User not found', 404);
  if (user.otp !== otp) throw err('Invalid OTP', 400);
  user.otp = null;
  if (role === 'STUDENT') user.lastLogin = new Date();
  await appendFcmToken(user, fcmToken);
  await user.save();
  const token = jwt.sign(
    { id: user._id, type: role === 'ADMIN' ? (user.userType || 'admin') : 'student', libraryId: user.libraryId?._id || user.libraryId },
    config.jwt.secret, { expiresIn: config.jwt.expiration }
  );
  return { token, userData: buildUserData(user, role), role: role.toLowerCase() };
};

exports.forgotPassword = async (email) => {
  let user = await Student.findOne({ email }) || await Admin.findOne({ email });
  if (!user) throw err('No account found with that email', 404);
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  user.otp = otp; await user.save();
  return { otp, isDev: process.env.NODE_ENV === 'development' };
};

exports.verifyResetOTP = async (email, otp) => {
  const user = await Student.findOne({ email }) || await Admin.findOne({ email });
  if (!user) throw err('User not found', 404);
  if (user.otp !== otp) throw err('Invalid OTP', 400);
};

exports.resetPassword = async (email, otp, newPassword) => {
  const user = await Student.findOne({ email }) || await Admin.findOne({ email });
  if (!user) throw err('User not found', 404);
  if (user.otp !== otp) throw err('Invalid or expired OTP', 400);
  user.password = newPassword; user.otp = null; await user.save();
};

exports.updateFcmToken = async (userId, userType, fcmToken) => {
  const Model = userType === 'student' ? Student : Admin;
  const user  = await Model.findById(userId);
  if (!user) throw err('User not found', 404);
  if (!user.fcmTokens) user.fcmTokens = [];
  if (!user.fcmTokens.includes(fcmToken)) { user.fcmTokens.push(fcmToken); await user.save(); }
};
