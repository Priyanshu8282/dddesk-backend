const AuditLog = require('../models/auditLog.model');
const Admin = require('../models/admin.model');
const Student = require('../models/student.model');
const Library = require('../models/library.model');
const { startOfDayIST, endOfDayIST } = require('../utils/time');

// 'YYYY-MM-DD' = IST calendar day; ISO timestamps are used as-is
const parseBound = (v, end) => {
  if (!v) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? (end ? endOfDayIST(v) : startOfDayIST(v)) : new Date(v);
  return isNaN(d) ? null : d;
};

/**
 * Query audit logs. `forceLibraryId` pins the tenant (owner endpoint); superadmin may filter by libraryId.
 * Filters: action (prefix match with trailing *), resource, userId, from/to (date range), page, limit (<=200).
 */
exports.queryLogs = async (query = {}, { forceLibraryId = null } = {}) => {
  const { action, resource, userId, libraryId, from, to } = query;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));

  const filter = {};
  if (forceLibraryId) filter.libraryId = forceLibraryId;
  else if (libraryId) filter.libraryId = libraryId;
  if (action) {
    filter.action = action.endsWith('*')
      ? { $regex: `^${action.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }
      : action;
  }
  if (resource) filter.resource = resource;
  if (userId) filter.userId = userId;

  const gte = parseBound(from, false);
  const lte = parseBound(to, true);
  if (gte || lte) filter.createdAt = { ...(gte && { $gte: gte }), ...(lte && { $lte: lte }) };

  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  // userId has no single ref (admins and students both log), so resolve actors manually
  const adminIds = [], studentIds = [], libIds = [];
  logs.forEach((l) => {
    if (l.userType === 'student') studentIds.push(l.userId); else if (l.userType !== 'system') adminIds.push(l.userId);
    if (l.libraryId) libIds.push(l.libraryId);
  });
  const [admins, students, libs] = await Promise.all([
    adminIds.length ? Admin.find({ _id: { $in: adminIds } }).select('name email userType').lean() : [],
    studentIds.length ? Student.find({ _id: { $in: studentIds } }).select('name mobile').lean() : [],
    !forceLibraryId && libIds.length ? Library.find({ _id: { $in: libIds } }).select('name').lean() : [],
  ]);
  const actor = new Map([...admins, ...students].map((u) => [String(u._id), { _id: u._id, name: u.name, email: u.email, mobile: u.mobile, userType: u.userType }]));
  const libName = new Map(libs.map((l) => [String(l._id), l.name]));

  const data = logs.map((l) => ({
    ...l,
    actor: actor.get(String(l.userId)) || null,
    ...(libName.size ? { libraryName: libName.get(String(l.libraryId)) || null } : {}),
  }));

  return { data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
};
