const PlatformPlan = require('../models/platformPlan.model');
const Library = require('../models/library.model');
const pick = require('../utils/pick');
const audit = require('../utils/audit');
const slugify = (s = '') =>
  String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 50).replace(/-+$/g, '');

const err = (msg, status) => Object.assign(new Error(msg), { status });

const FIELDS = ['name', 'description', 'monthlyPrice', 'annualPrice', 'gstPercent', 'isPopular', 'sortOrder', 'trialDays', 'graceDays',
  'maxStudents', 'maxSeats', 'maxStaff', 'maxBranches', 'features', 'isActive'];
const LIMIT_FIELDS = ['maxStudents', 'maxSeats', 'maxStaff', 'maxBranches'];

const uniqueSlug = async (name) => {
  const base = slugify(name) || 'plan';
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await PlatformPlan.exists({ slug: candidate }))) return candidate;
  }
  return `${base}-${Date.now()}`;
};

// Plans with the number of libraries on each (one grouped query, not one per plan)
exports.list = async () => {
  const [plans, counts] = await Promise.all([
    PlatformPlan.find({ isDeleted: false }).sort({ sortOrder: 1, monthlyPrice: 1 }).lean(),
    Library.aggregate([
      { $match: { isDeleted: false, subscriptionPlanId: { $ne: null } } },
      { $group: { _id: '$subscriptionPlanId', n: { $sum: 1 } } },
    ]),
  ]);
  const byPlan = new Map(counts.map((c) => [String(c._id), c.n]));
  return plans.map((p) => ({ ...p, gstPercent: p.gstPercent ?? 18, isPopular: !!p.isPopular, sortOrder: p.sortOrder ?? 0, libraryCount: byPlan.get(String(p._id)) || 0 }));
};

const assertUniqueName = async (name, exceptId = null) => {
  if (!name) return;
  const clash = await PlatformPlan.findOne({
    isDeleted: false, name: new RegExp('^' + String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'),
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  }).select('_id').lean();
  if (clash) throw err('A plan with this name already exists.', 409);
};

exports.get = async (id) => {
  const plan = await PlatformPlan.findOne({ _id: id, isDeleted: false });
  if (!plan) throw err('Plan not found.', 404);
  const libraries = await Library.countDocuments({ subscriptionPlanId: id, isDeleted: false });
  return { ...plan.toObject(), gstPercent: plan.gstPercent ?? 18, libraryCount: libraries };
};

exports.create = async (req) => {
  const body = pick(req.body, FIELDS);
  await assertUniqueName(body.name);
  const plan = await PlatformPlan.create({ ...body, slug: await uniqueSlug(body.name), createdBy: req.user._id });
  await audit(req, 'platform_plan.create', 'PlatformPlan', plan._id, { name: plan.name });
  return plan;
};

// Updates the plan and refreshes the entitlement snapshot (planLimits / plan name) of libraries on it
exports.update = async (req, id) => {
  const body = pick(req.body, FIELDS);
  if (!Object.keys(body).length) throw err('No valid fields to update.', 400);
  await assertUniqueName(body.name, id);
  const plan = await PlatformPlan.findOneAndUpdate(
    { _id: id, isDeleted: false }, { $set: body }, { new: true, runValidators: true }
  );
  if (!plan) throw err('Plan not found.', 404);

  let propagated = 0;
  const set = {};
  LIMIT_FIELDS.forEach((k) => { if (body[k] !== undefined) set[`planLimits.${k}`] = plan[k]; });
  if (body.name !== undefined) set.subscriptionPlan = plan.name;
  if (Object.keys(set).length) {
    const r = await Library.updateMany({ subscriptionPlanId: plan._id, isDeleted: false }, { $set: set });
    propagated = r.modifiedCount || 0;
  }

  await audit(req, 'platform_plan.update', 'PlatformPlan', plan._id, { fields: Object.keys(body), librariesUpdated: propagated });
  return { plan, propagated };
};

exports.archive = async (req, id) => {
  const inUse = await Library.countDocuments({ subscriptionPlanId: id, isDeleted: false, status: { $in: ['active', 'pending', 'suspended'] } });
  if (inUse > 0) throw err(`Plan is assigned to ${inUse} librar${inUse === 1 ? 'y' : 'ies'}. Move them to another plan first, or deactivate the plan instead.`, 400);
  const plan = await PlatformPlan.findOneAndUpdate({ _id: id, isDeleted: false }, { $set: { isDeleted: true, isActive: false } }, { new: true });
  if (!plan) throw err('Plan not found.', 404);
  await audit(req, 'platform_plan.archive', 'PlatformPlan', plan._id, { name: plan.name });
};
