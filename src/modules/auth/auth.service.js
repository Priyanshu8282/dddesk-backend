const jwt     = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const Admin    = require('../admins/admin.model');
const Student  = require('../students/student.model');
const config   = require('../../config/config');

const pickModel = (userRole) =>
  userRole === 'STUDENT' ? Student : Admin;

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
  if (role === 'ADMIN') {
    data.role = user.roleId?.name;
    data.libraryId = user.libraryId;
  } else {
    data.libraryId = user.libraryId?._id || user.libraryId;
  }
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

exports.login = async ({ identifier, email, mobile, password, userRole, fcmToken }) => {
  const role = userRole === 'STUDENT' ? 'STUDENT' : 'ADMIN';
  const Model = pickModel(role);

  const loginEmail  = email  || (identifier && identifier.includes('@') ? identifier : '');
  const loginMobile = mobile || (identifier && !identifier.includes('@') ? identifier : '');

  let query = {};
  if (loginEmail && loginMobile) query = { $or: [{ email: loginEmail }, { mobile: loginMobile }] };
  else if (loginEmail)  query = { email: loginEmail };
  else if (loginMobile) query = { mobile: loginMobile };
  else throw Object.assign(new Error('Email or Mobile is required'), { status: 400 });

  const user = await Model.findOne({ ...query, isDeleted: { $ne: true } })
    .populate(role === 'ADMIN' ? { path: 'roleId', populate: { path: 'permissionIds' } } : 'libraryId');

  if (!user) {
    const msg = loginMobile && !loginEmail ? 'Mobile number not found'
              : loginEmail && !loginMobile  ? 'Email address not found'
              : 'User not found';
    throw Object.assign(new Error(msg), { status: 401 });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw Object.assign(new Error('Incorrect password'), { status: 401 });
  if (role === 'STUDENT' && user.status !== 'active')
    throw Object.assign(new Error('Account is inactive'), { status: 403 });

  await appendFcmToken(user, fcmToken);
  const token    = buildToken(user, role);
  const userData = buildUserData(user, role);
  return { token, userData, role: role.toLowerCase() };
};

exports.sendOTP = async ({ mobile, userRole }) => {
  const role  = userRole === 'STUDENT' ? 'STUDENT' : 'ADMIN';
  const Model = pickModel(role);
  const user  = await Model.findOne({ mobile });
  if (!user) throw Object.assign(new Error('Mobile number not found'), { status: 404 });
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
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.otp !== otp) throw Object.assign(new Error('Invalid OTP'), { status: 400 });

  user.otp = null;
  if (role === 'STUDENT') user.lastLogin = new Date();
  await appendFcmToken(user, fcmToken);
  await user.save();

  const token = jwt.sign(
    { id: user._id, type: role === 'ADMIN' ? (user.userType || 'admin') : 'student', libraryId: user.libraryId?._id || user.libraryId },
    config.jwt.secret,
    { expiresIn: config.jwt.expiration }
  );
  return { token, userData: buildUserData(user, role), role: role.toLowerCase() };
};

exports.forgotPassword = async (email) => {
  let user = await Student.findOne({ email });
  let role = 'STUDENT';
  if (!user) { user = await Admin.findOne({ email }); role = 'ADMIN'; }
  if (!user) throw Object.assign(new Error('No account found with that email'), { status: 404 });
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  user.otp = otp;
  await user.save();
  return { otp, isDev: process.env.NODE_ENV === 'development' };
};

exports.verifyResetOTP = async (email, otp) => {
  let user = await Student.findOne({ email });
  if (!user) user = await Admin.findOne({ email });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.otp !== otp) throw Object.assign(new Error('Invalid OTP'), { status: 400 });
};

exports.resetPassword = async (email, otp, newPassword) => {
  let user = await Student.findOne({ email });
  if (!user) user = await Admin.findOne({ email });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.otp !== otp) throw Object.assign(new Error('Invalid or expired OTP'), { status: 400 });
  user.password = newPassword;
  user.otp = null;
  await user.save();
};

exports.updateFcmToken = async (userId, userType, fcmToken) => {
  const Model = userType === 'student' ? Student : Admin;
  const user  = await Model.findById(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (!user.fcmTokens) user.fcmTokens = [];
  if (!user.fcmTokens.includes(fcmToken)) { user.fcmTokens.push(fcmToken); await user.save(); }
};
