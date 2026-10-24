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
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
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
        id: user.libraryId._id, name: user.libraryId.name,
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
    await user.save({ validateModifiedOnly: true });
  }
};

// Optional tenant hint (libraryId) for accounts that can exist in several libraries
const resolveTenantHint = async ({ libraryId }) => libraryId || null;

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

exports.login = async ({ identifier, email, mobile, password, userRole, fcmToken, libraryId }) => {
  const role = isStudentRole(userRole) ? 'STUDENT' : 'ADMIN';

  const rawEmail  = email  || (identifier && identifier.includes('@') ? identifier : '');
  const rawMobile = mobile || (identifier && !identifier.includes('@') ? identifier : '');
  const loginEmail  = rawEmail ? rawEmail.trim().toLowerCase() : '';
  const loginMobile = rawMobile ? normalizeMobile(rawMobile) : '';
  if (!loginEmail && !loginMobile) throw fail(400, 'Email or Mobile is required');

  const tenant = await resolveTenantHint({ libraryId });
  const candidates = await findCandidates(
    role,
    { email: loginEmail, mobile: loginEmail ? '' : loginMobile, libraryId: tenant },
    { withSecrets: ['password', 'failedLogins', 'lockUntil'] }
  );
  const AccountModel = role === 'STUDENT' ? Student : Admin;

  // Per-account lockout: stops password guessing spread across many IPs
  const locked = candidates.find((c) => c.lockUntil && c.lockUntil.getTime() > Date.now());
  if (locked) {
    const minutes = Math.max(1, Math.ceil((locked.lockUntil.getTime() - Date.now()) / 60000));
    throw fail(429, `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or sign in with an OTP.`);
  }

  // Compare against every candidate (a student mobile can exist in several libraries); constant-ish work when none
  let user = null;
  if (!candidates.length) {
    await bcrypt.compare(password, DUMMY_HASH);
  }
  for (const c of candidates) {
    if (c.password && await bcrypt.compare(password, c.password)) { user = c; break; }
  }
  if (!user) {
    // Count the failure atomically; the 10th one starts the lock
    for (const c of candidates) {
      const upd = await AccountModel.findOneAndUpdate({ _id: c._id }, { $inc: { failedLogins: 1 } }, { new: true, projection: { failedLogins: 1 } });
      if (upd && upd.failedLogins >= LOGIN_MAX_FAILURES) {
        await AccountModel.updateOne({ _id: c._id }, { $set: { failedLogins: 0, lockUntil: new Date(Date.now() + LOGIN_LOCK_MS) } });
      }
    }
    throw fail(401, 'Invalid credentials');
  }

  if (role === 'ADMIN') {
    if (!user.status) throw fail(403, 'Your account has been disabled. Contact your library owner.');
    if (user.userType !== 'superadmin') assertLibraryUsable(user);
  } else {
    if (user.status !== 'active') throw fail(403, 'Account is inactive');
    assertLibraryUsable(user);
  }

  // Targeted update (not save()): older accounts may lack fields the schema now requires (e.g. mobile),
  // and a successful login must never fail on unrelated validation.
  const now = new Date();
  const loginUpdate = { $set: { lastLogin: now, failedLogins: 0 }, $unset: { lockUntil: '' } };
  if (fcmToken && !(user.fcmTokens || []).includes(fcmToken)) loginUpdate.$addToSet = { fcmTokens: fcmToken };
  await AccountModel.updateOne({ _id: user._id }, loginUpdate);
  user.lastLogin = now;

  const token    = buildToken(user, role);
  const userData = buildUserData(user, role);
  return { token, userData, role: role.toLowerCase() };
};

// ---------------------------------------------------------------------------
// OTP (login + password reset) - one implementation for super admin, library owner, staff and student
// ---------------------------------------------------------------------------

// OTP in the API response is OFF by default. It is exposed only when OTP_IN_RESPONSE=true is set explicitly
// (testing without an SMS/e-mail provider) and never when NODE_ENV=production.
const otpInResponse = () =>
  String(process.env.OTP_IN_RESPONSE || '').toLowerCase() === 'true' && process.env.NODE_ENV !== 'production';

// "a@b.com" -> email, anything else -> mobile
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const resolveTarget = ({ identifier, email, mobile }) => {
  const raw = String(email || identifier || '').trim();
  if (raw && EMAIL_RE.test(raw)) return { email: raw.toLowerCase(), mobile: '' };
  const m = mobile || (!EMAIL_RE.test(raw) ? raw : '');
  return { email: '', mobile: m ? normalizeMobile(m) : '' };
};

const maskTarget = ({ email, mobile }) => {
  if (email) { const [n, d] = email.split('@'); return `${n.slice(0, 2)}${'*'.repeat(Math.max(1, n.length - 2))}@${d}`; }
  if (mobile) return `${'*'.repeat(Math.max(0, mobile.length - 4))}${mobile.slice(-4)}`;
  return '';
};

const modelOf = (user) => user.constructor;

// Targeted updates (not save()): older accounts may lack fields the schema now requires (e.g. mobile),
// and OTP login/reset must never fail on unrelated validation.
const setOtpFields = (user, fields) => modelOf(user).updateOne({ _id: user._id }, { $set: fields });

// Stores a hashed OTP with a 10 min expiry and resets the attempt counter
const issueOtp = async (user, { channel = 'sms', purpose = 'login', target = {} } = {}) => {
  const otp = generateOtp();
  await setOtpFields(user, { otp: hashOtp(otp), otpExpires: new Date(Date.now() + OTP_TTL_MS), otpAttempts: 0 });
  // Delivery via the registered provider (never throws, never logs the OTP)
  try {
    const to = channel === 'email' ? user.email : user.mobile;
    if (to) await require('./notification.service').deliverOtp({ channel, to, otp, purpose });
  } catch (_) { /* delivery failure must not reveal account state */ }
  return {
    otp, isDev: otpInResponse(), channel,
    sentTo: maskTarget(target), expiresInSeconds: OTP_TTL_MS / 1000
  };
};

// What the API returns when no account matches (identical shape, so accounts cannot be enumerated)
const noAccountOtp = (channel, target) => ({
  otp: null, isDev: false, channel, sentTo: maskTarget(target), expiresInSeconds: OTP_TTL_MS / 1000
});

// Validates an OTP: expiry, attempt limit, hash. Burns the OTP on too many attempts.
const checkOtp = async (user, otp) => {
  if (!user.otp || !user.otpExpires || user.otpExpires.getTime() < Date.now()) {
    throw fail(400, 'OTP expired or not requested. Please request a new one.');
  }
  // Reserve the attempt atomically first so parallel guesses cannot exceed OTP_MAX_ATTEMPTS
  const reserved = await modelOf(user).findOneAndUpdate(
    { _id: user._id, otp: user.otp, otpExpires: { $gt: new Date() }, otpAttempts: { $lt: OTP_MAX_ATTEMPTS } },
    { $inc: { otpAttempts: 1 } },
    { new: true, projection: { otpAttempts: 1 } }
  );
  if (!reserved) {
    await setOtpFields(user, { otp: null, otpExpires: null, otpAttempts: 0 });
    throw fail(429, 'Too many incorrect attempts. Please request a new OTP.');
  }
  const a = Buffer.from(hashOtp(String(otp)), 'hex');
  const b = Buffer.from(user.otp, 'hex');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) throw fail(400, 'Invalid OTP');
};

const clearOtp = (user) => setOtpFields(user, { otp: null, otpExpires: null, otpAttempts: 0 });

// Single account for an OTP flow; ambiguity (same student mobile in many libraries) must be resolved by the caller
const findOtpAccount = async ({ email, mobile, userRole, libraryId }) => {
  const tenant = await resolveTenantHint({ libraryId });
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

// Login OTP: works for super admin, library owner and staff (and students with userRole=STUDENT),
// using an email OR a mobile number. Super admin / owner / staff all live in the Admin collection.
exports.sendOTP = async ({ identifier, email, mobile, userRole, libraryId }) => {
  const target = resolveTarget({ identifier, email, mobile });
  if (!target.email && !target.mobile) throw fail(400, 'Enter a valid email or mobile number');
  const channel = target.email ? 'email' : 'sms';
  const { user } = await findOtpAccount({ ...target, userRole: userRole || 'ADMIN', libraryId });
  if (!user || (user.status === false) || (user.status === 'inactive')) return noAccountOtp(channel, target);
  return issueOtp(user, { channel, purpose: 'login', target });
};

exports.verifyOTP = async ({ identifier, email, mobile, otp, userRole, fcmToken, libraryId }) => {
  const role = isStudentRole(userRole) ? 'STUDENT' : 'ADMIN';
  const target = resolveTarget({ identifier, email, mobile });
  const { user } = await findOtpAccount({ ...target, userRole: role, libraryId });
  if (!user) throw fail(400, 'Invalid OTP');
  await checkOtp(user, otp);

  if (role === 'ADMIN') {
    if (!user.status) throw fail(403, 'Your account has been disabled. Contact your library owner.');
    if (user.userType !== 'superadmin') assertLibraryUsable(user);
  } else {
    if (user.status !== 'active') throw fail(403, 'Account is inactive');
    assertLibraryUsable(user);
  }

  const update = { $set: { lastLogin: new Date(), otp: null, otpExpires: null, otpAttempts: 0 } };
  if (fcmToken && !(user.fcmTokens || []).includes(fcmToken)) update.$addToSet = { fcmTokens: fcmToken };
  await modelOf(user).updateOne({ _id: user._id }, update);

  const token = buildToken(user, role, { libraryId: user.libraryId?._id || user.libraryId });
  return { token, userData: buildUserData(user, role), role: role.toLowerCase() };
};

exports.forgotPassword = async ({ email, mobile, libraryId }) => {
  const target = resolveTarget({ email, mobile });
  const channel = target.email ? 'email' : 'sms';
  const { user } = await findOtpAccount({ ...target, libraryId });
  if (!user || user.status === false || user.status === 'inactive') return noAccountOtp(channel, target);
  return issueOtp(user, { channel, purpose: 'password reset', target });
};

exports.verifyResetOTP = async ({ email, mobile, otp, libraryId }) => {
  const target = resolveTarget({ email, mobile });
  const { user } = await findOtpAccount({ ...target, libraryId });
  if (!user) throw fail(400, 'Invalid OTP');
  await checkOtp(user, otp);
};

exports.resetPassword = async ({ email, mobile, otp, newPassword, libraryId }) => {
  const target = resolveTarget({ email, mobile });
  const { user } = await findOtpAccount({ ...target, libraryId });
  if (!user) throw fail(400, 'Invalid or expired OTP');
  await checkOtp(user, otp);
  user.password = newPassword; // hashed by the model pre-save hook
  user.tokensValidAfter = new Date(); // a forgotten/stolen password must also end existing sessions
  user.otp = null; user.otpExpires = null; user.otpAttempts = 0;
  await user.save({ validateBeforeSave: false }); // pre-save hook still hashes; skips unrelated legacy-field validation
  await require('./session.service').revokeAllForUser(user._id, 'password_reset');
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
  await user.save({ validateModifiedOnly: true }); // older accounts may lack newer required fields (e.g. mobile)
};

exports.updateFcmToken = async (userId, userType, fcmToken) => {
  const Model = userType === 'student' ? Student : Admin;
  const user  = await Model.findById(userId);
  if (!user) throw fail(404, 'User not found');
  if (!user.fcmTokens) user.fcmTokens = [];
  if (!user.fcmTokens.includes(fcmToken)) {
    user.fcmTokens.push(fcmToken);
    user.markModified('fcmTokens');
    await user.save({ validateModifiedOnly: true });
  }
};

exports.removeFcmToken = async (userId, userType, fcmToken) => {
  const Model = userType === 'student' ? Student : Admin;
  await Model.updateOne({ _id: userId }, { $pull: { fcmTokens: fcmToken } });
};

exports.buildToken = buildToken;
exports.buildUserData = buildUserData;
