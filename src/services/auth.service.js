const jwt     = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const Admin    = require('../models/admin.model');
const Student  = require('../models/student.model');
const Library  = require('../models/library.model');
const config   = require('../config/config');
const { normalizeMobile } = require('../utils/mobile');

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
// Used to spend comparable time when the account does not exist
const DUMMY_HASH = bcrypt.hashSync('dddesk-dummy-password', 10);

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const isStudentRole = (userRole) => String(userRole || '').toUpperCase() === 'STUDENT';

const hashOtp = (otp) => crypto.createHash('sha256').update(`${otp}:${config.jwt.secret}`).digest('hex');
const generateOtp = () => String(crypto.randomInt(100000, 1000000));

const buildToken = (user, role, extra = {}) =>
  jwt.sign(
    { id: user._id, type: role === 'ADMIN' ? (user.userType || 'admin') : 'student', ...extra },
    config.jwt.secret,
    { expiresIn: config.jwt.expiration }
  );

const buildUserData = (user, role) => {
  const permissions = user.roleId?.permissionIds?.map(p => p.key) || [];
  const data = {
    id: user._id, name: user.name, email: user.email, mobile: user.mobile,
    profileImage: user.profileImage,
    userType: role === 'ADMIN' ? (user.userType || 'admin') : 'student',
    permissions,
  };
  if (role === 'ADMIN') {
    data.role = user.roleId?.name;
    data.libraryId = user.libraryId?._id || user.libraryId;
    data.branchIds = user.branchIds || [];
    if (user.libraryId?._id) {
      data.library = {
        id: user.libraryId._id, name: user.libraryId.name, slug: user.libraryId.slug || null,
        status: user.libraryId.status, logo: user.libraryId.logo || null,
      };
    }
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

// Resolves slug -> libraryId for the optional tenant hint
const resolveTenantHint = async ({ libraryId, slug }) => {
  if (libraryId) return libraryId;
  if (slug) {
    const { library } = await Library.findBySlugOrPrevious(slug);
    return library?._id || null;
  }
  return null;
};

// Throws a 403 carrying libraryStatus when the library cannot be used
const assertLibraryUsable = (user) => {
  const lib = user.libraryId && user.libraryId._id ? user.libraryId : null;
  if (!lib || lib.isDeleted || lib.status !== 'active') {
    const state = lib && !lib.isDeleted ? lib.status : 'missing';
    const message = state === 'pending' ? 'Your library registration is awaiting Super Admin approval.'
      : state === 'rejected' ? 'Your library registration was rejected.'
      : state === 'suspended' ? 'Your library is suspended. Please contact support.'
      : 'Library not found or inactive.';
    throw fail(403, message, { libraryStatus: state, statusReason: lib?.statusReason || null });
  }
};

const adminPopulate = [
  { path: 'roleId', populate: { path: 'permissionIds' } },
  { path: 'libraryId' },
];

// Finds candidate accounts for a login-like identifier (email or mobile)
const findCandidates = async (role, { email, mobile, libraryId }, { withSecrets = [] } = {}) => {
  const query = {};
  if (email) query.email = String(email).toLowerCase();
  else if (mobile) query.mobile = mobile;
  if (role === 'STUDENT' && libraryId) query.libraryId = libraryId;
  const Model = role === 'STUDENT' ? Student : Admin;
  let q = Model.find({ ...query, isDeleted: { $ne: true } });
  if (withSecrets.length) q = q.select(withSecrets.map((s) => `+${s}`).join(' '));
  q = role === 'STUDENT' ? q.populate('libraryId') : q.populate(adminPopulate);
  return q;
};

exports.login = async ({ identifier, email, mobile, password, userRole, fcmToken, libraryId, slug }) => {
  const role = isStudentRole(userRole) ? 'STUDENT' : 'ADMIN';

  const rawEmail  = email  || (identifier && identifier.includes('@') ? identifier : '');
  const rawMobile = mobile || (identifier && !identifier.includes('@') ? identifier : '');
  const loginEmail  = rawEmail ? rawEmail.trim().toLowerCase() : '';
  const loginMobile = rawMobile ? normalizeMobile(rawMobile) : '';
  if (!loginEmail && !loginMobile) throw fail(400, 'Email or Mobile is required');

  const tenant = await resolveTenantHint({ libraryId, slug });
  const candidates = await findCandidates(
    role,
    { email: loginEmail, mobile: loginEmail ? '' : loginMobile, libraryId: tenant },
    { withSecrets: ['password'] }
  );

  // Compare against every candidate (a student mobile can exist in several libraries); constant-ish work when none
  let user = null;
  if (!candidates.length) {
    await bcrypt.compare(password, DUMMY_HASH);
  }
  for (const c of candidates) {
    if (c.password && await bcrypt.compare(password, c.password)) { user = c; break; }
  }
  if (!user) throw fail(401, 'Invalid credentials');

  if (role === 'ADMIN') {
    if (!user.status) throw fail(403, 'Your account has been disabled. Contact your library owner.');
    if (user.userType !== 'superadmin') assertLibraryUsable(user);
  } else {
    if (user.status !== 'active') throw fail(403, 'Account is inactive');
    assertLibraryUsable(user);
  }

  user.lastLogin = new Date();
  user.fcmTokens = user.fcmTokens || [];
  if (fcmToken && !user.fcmTokens.includes(fcmToken)) user.fcmTokens.push(fcmToken);
  user.markModified('fcmTokens');
  await user.save();

  const token    = buildToken(user, role);
  const userData = buildUserData(user, role);
  return { token, userData, role: role.toLowerCase() };
};

// Stores a hashed OTP with a 10 min expiry and resets the attempt counter
const issueOtp = async (user, { channel = 'sms', purpose = 'login' } = {}) => {
  const otp = generateOtp();
  user.otp = hashOtp(otp);
  user.otpExpires = new Date(Date.now() + OTP_TTL_MS);
  user.otpAttempts = 0;
  await user.save();
  // Delivery via the registered provider (never throws, never logs the OTP); the code is only returned in development.
  try {
    const to = channel === 'email' ? user.email : user.mobile;
    await require('./notification.service').deliverOtp({ channel, to, otp, purpose });
  } catch (_) { /* delivery failure must not reveal account state */ }
  return { otp, isDev: process.env.NODE_ENV === 'development' };
};

// Validates an OTP: expiry, attempt limit, hash. Burns the OTP on too many attempts.
const checkOtp = async (user, otp) => {
  if (!user.otp || !user.otpExpires || user.otpExpires.getTime() < Date.now()) {
    throw fail(400, 'OTP expired or not requested. Please request a new one.');
  }
  if ((user.otpAttempts || 0) >= OTP_MAX_ATTEMPTS) {
    user.otp = null; user.otpExpires = null; user.otpAttempts = 0;
    await user.save();
    throw fail(429, 'Too many incorrect attempts. Please request a new OTP.');
  }
  const a = Buffer.from(hashOtp(String(otp)), 'hex');
  const b = Buffer.from(user.otp, 'hex');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    user.otpAttempts = (user.otpAttempts || 0) + 1;
    await user.save();
    throw fail(400, 'Invalid OTP');
  }
};

const clearOtp = (user) => { user.otp = null; user.otpExpires = null; user.otpAttempts = 0; };

// Single account for an OTP flow; ambiguity (same student mobile in many libraries) must be resolved by the caller
const findOtpAccount = async ({ email, mobile, userRole, libraryId, slug }) => {
  const tenant = await resolveTenantHint({ libraryId, slug });
  const normMobile = mobile ? normalizeMobile(mobile) : '';
  const lookups = userRole === undefined
    ? [['ADMIN'], ['STUDENT']]               // forgot-password: admin first (unique e-mail), then student
    : [[isStudentRole(userRole) ? 'STUDENT' : 'ADMIN']];
  for (const [role] of lookups) {
    let list = await findCandidates(role, { email, mobile: email ? '' : normMobile, libraryId: tenant },
      { withSecrets: ['otp', 'otpExpires', 'otpAttempts'] });
    if (list.length === 1) return { user: list[0], role };
    if (list.length > 1) throw fail(409, 'This number is registered in more than one library. Please specify the library.');
  }
  return { user: null, role: null };
};

exports.sendOTP = async ({ mobile, userRole, libraryId, slug }) => {
  const { user } = await findOtpAccount({ mobile, userRole: userRole || 'ADMIN', libraryId, slug });
  // Same response whether or not the number exists (no account enumeration)
  if (!user || (user.status === false) || (user.status === 'inactive')) return { otp: null, isDev: false };
  return issueOtp(user, { channel: 'sms', purpose: 'login' });
};

exports.verifyOTP = async ({ mobile, otp, userRole, fcmToken, libraryId, slug }) => {
  const role = isStudentRole(userRole) ? 'STUDENT' : 'ADMIN';
  const { user } = await findOtpAccount({ mobile, userRole: role, libraryId, slug });
  if (!user) throw fail(400, 'Invalid OTP');
  await checkOtp(user, otp);

  if (role === 'ADMIN') {
    if (!user.status) throw fail(403, 'Your account has been disabled. Contact your library owner.');
    if (user.userType !== 'superadmin') assertLibraryUsable(user);
  } else {
    if (user.status !== 'active') throw fail(403, 'Account is inactive');
    assertLibraryUsable(user);
  }

  clearOtp(user);
  user.lastLogin = new Date();
  if (fcmToken) {
    user.fcmTokens = user.fcmTokens || [];
    if (!user.fcmTokens.includes(fcmToken)) { user.fcmTokens.push(fcmToken); user.markModified('fcmTokens'); }
  }
  await user.save();

  const token = buildToken(user, role, { libraryId: user.libraryId?._id || user.libraryId });
  return { token, userData: buildUserData(user, role), role: role.toLowerCase() };
};

exports.forgotPassword = async ({ email, mobile, libraryId, slug }) => {
  const { user } = await findOtpAccount({ email, mobile, libraryId, slug });
  if (!user || user.status === false || user.status === 'inactive') return { otp: null, isDev: false };
  return issueOtp(user, { channel: email ? 'email' : 'sms', purpose: 'password reset' });
};

exports.verifyResetOTP = async ({ email, mobile, otp, libraryId, slug }) => {
  const { user } = await findOtpAccount({ email, mobile, libraryId, slug });
  if (!user) throw fail(400, 'Invalid OTP');
  await checkOtp(user, otp);
};

exports.resetPassword = async ({ email, mobile, otp, newPassword, libraryId, slug }) => {
  const { user } = await findOtpAccount({ email, mobile, libraryId, slug });
  if (!user) throw fail(400, 'Invalid or expired OTP');
  await checkOtp(user, otp);
  user.password = newPassword; // hashed by the model pre-save hook
  user.tokensValidAfter = new Date(); // a forgotten/stolen password must also end existing sessions
  clearOtp(user);
  await user.save();
};

/**
 * Change password for the logged in account (admin/staff/student). Requires the current password.
 * Uses save() so the model hook hashes exactly once.
 */
exports.changePassword = async (userId, userType, currentPassword, newPassword) => {
  const Model = userType === 'student' ? Student : Admin;
  const user = await Model.findById(userId).select('+password');
  if (!user) throw fail(404, 'User not found');
  if (!currentPassword || !(await bcrypt.compare(currentPassword, user.password))) {
    throw fail(400, 'Current password is incorrect');
  }
  if (await bcrypt.compare(newPassword, user.password)) {
    throw fail(400, 'New password must be different from the current password');
  }
  user.password = newPassword;
  await user.save();
};

exports.updateFcmToken = async (userId, userType, fcmToken) => {
  const Model = userType === 'student' ? Student : Admin;
  const user  = await Model.findById(userId);
  if (!user) throw fail(404, 'User not found');
  if (!user.fcmTokens) user.fcmTokens = [];
  if (!user.fcmTokens.includes(fcmToken)) {
    user.fcmTokens.push(fcmToken);
    user.markModified('fcmTokens');
    await user.save();
  }
};

exports.buildToken = buildToken;
exports.buildUserData = buildUserData;
