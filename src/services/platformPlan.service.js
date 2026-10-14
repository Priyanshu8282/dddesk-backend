const PlatformPlan = require('../models/platformPlan.model');
const Library = require('../models/library.model');
const pick = require('../utils/pick');
const audit = require('../utils/audit');
const { slugify } = require('../utils/slug');

const err = (msg, status) => Object.assign(new Error(msg), { status });

const FIELDS = ['name', 'description', 'monthlyPrice', 'annualPrice', 'trialDays', 'graceDays',
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

exports.list = async () => PlatformPlan.find({ isDeleted: false }).sort({ monthlyPrice: 1 });

exports.get = async (id) => {
  const plan = await PlatformPlan.findOne({ _id: id, isDeleted: false });
  if (!plan) throw err('Plan not found.', 404);
  const libraries = await Library.countDocuments({ subscriptionPlanId: id, isDeleted: false });
  return { ...plan.toObject(), libraryCount: libraries };
};

exports.create = async (req) => {
  const body = pick(req.body, FIELDS);
  const plan = await PlatformPlan.create({ ...body, slug: await uniqueSlug(body.name), createdBy: req.user._id });
  await audit(req, 'platform_plan.create', 'PlatformPlan', plan._id, { name: plan.name });
  return plan;
};

// Updates the plan and refreshes the entitlement snapshot (planLimits / plan name) of libraries on it
exports.update = async (req, id) => {
  const body = pick(req.body, FIELDS);
  if (!Object.keys(body).length) throw err('No valid fields to update.', 400);
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
