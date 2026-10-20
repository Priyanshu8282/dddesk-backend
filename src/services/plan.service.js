const mongoose = require('mongoose');
const Plan = require('../models/plan.model');
const Student = require('../models/student.model');
const ApiError = require('../utils/ApiError');
const pick = require('../utils/pick');
const escapeRegex = require('../utils/escapeRegex');

const PLAN_FIELDS = [
    'name', 'description', 'durationType', 'durationDays', 'price', 'discount', 'depositAmount', 'joiningFee',
    'features', 'seatTypes', 'shiftName', 'shiftStart', 'shiftEnd', 'allowRenewal', 'autoRenewReminderDays', 'status'
];

const LIVE_MEMBERSHIP = ['active', 'pending', 'paused'];

const assertId = (id) => {
    if (!mongoose.Types.ObjectId.isValid(String(id))) throw new ApiError(404, 'Plan not found');
};

/** Real duration in days for a plan (durationDays, else derived from durationType). */
const getPlanDurationDays = (plan) => {
    const days = Number(plan.durationDays) || Plan.DURATION_DAYS[plan.durationType];
    if (!days || days < 1) throw new ApiError(400, `Plan "${plan.name}" has no valid duration`);
    return days;
};

const assertUniqueName = async (libraryId, name, exceptId) => {
    const q = { libraryId, name: { $regex: '^' + escapeRegex(String(name).trim()) + '$', $options: 'i' } };
    if (exceptId) q._id = { $ne: exceptId };
    if (await Plan.exists(q)) throw new ApiError(409, 'A plan with this name already exists');
};

const createPlan = async (libraryId, body, createdBy) => {
    const data = pick(body, PLAN_FIELDS);
    if (data.durationType === 'custom' && !(Number(data.durationDays) > 0)) {
        throw new ApiError(400, 'durationDays is required for custom plans');
    }
    await assertUniqueName(libraryId, data.name);
    return Plan.create({ ...data, libraryId, createdBy });
};

const SORTS = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    name: { name: 1, _id: 1 },
    'price-low': { finalPrice: 1, _id: 1 },
    'price-high': { finalPrice: -1, _id: 1 }
};

/** { planId -> { live, total } } student counts for the given plans (one aggregate) */
const studentCountsFor = async (libraryId, planIds) => {
    if (!planIds.length) return {};
    const rows = await Student.aggregate([
        { $match: { libraryId: new mongoose.Types.ObjectId(String(libraryId)), isDeleted: false, planId: { $in: planIds } } },
        { $group: { _id: '$planId', total: { $sum: 1 }, live: { $sum: { $cond: [{ $in: ['$planStatus', LIVE_MEMBERSHIP] }, 1, 0] } } } }
    ]);
    const map = {};
    rows.forEach((r) => { map[String(r._id)] = { live: r.live, total: r.total }; });
    return map;
};

const withCounts = (plan, counts) => {
    const o = plan.toObject ? plan.toObject() : plan;
    const c = counts[String(o._id)] || { live: 0, total: 0 };
    return { ...o, studentsCount: c.live, totalStudents: c.total };
};

const queryPlans = async (filter, options = {}) => {
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit) || 100, 1), 200);
    const skip = (page - 1) * limit;
    const sort = SORTS[options.sort] || SORTS.newest;

    const [plans, totalResults] = await Promise.all([
        Plan.find(filter)
            .populate({ path: 'createdBy', select: 'name userType roleId', populate: { path: 'roleId', select: 'name' } })
            .sort(sort)
            .skip(skip)
            .limit(limit),
        Plan.countDocuments(filter)
    ]);
    const counts = await studentCountsFor(filter.libraryId, plans.map((p) => p._id));

    return {
        results: plans.map((p) => withCounts(p, counts)),
        page,
        limit,
        totalResults,
        totalPages: Math.max(1, Math.ceil(totalResults / limit))
    };
};

const buildPlanFilter = (libraryId, { search, status, duration } = {}) => {
    const filter = { libraryId, isDeleted: false };
    const s = status ? String(status).toLowerCase() : '';
    if (s === 'active') filter.status = true;
    else if (s === 'inactive') filter.status = false;
    if (duration && Plan.schema.path('durationType').enumValues.includes(String(duration))) filter.durationType = String(duration);
    if (search) filter.name = { $regex: escapeRegex(String(search).trim()), $options: 'i' };
    return filter;
};

const getPlanSummary = async (libraryId) => {
    const base = { libraryId, isDeleted: false };
    const [total, active, inactive] = await Promise.all([
        Plan.countDocuments(base),
        Plan.countDocuments({ ...base, status: true }),
        Plan.countDocuments({ ...base, status: false })
    ]);
    return { total, active, inactive };
};

/** Cards on top of the page: counts, students on plans, revenue potential, students per plan */
const getPlanStats = async (libraryId) => {
    const summary = await getPlanSummary(libraryId);
    const plans = await Plan.find({ libraryId, isDeleted: false }).select('name finalPrice status durationType');
    const counts = await studentCountsFor(libraryId, plans.map((p) => p._id));
    let studentsOnPlans = 0;
    let revenuePotential = 0;
    const perPlan = plans.map((p) => {
        const c = counts[String(p._id)] || { live: 0, total: 0 };
        studentsOnPlans += c.live;
        revenuePotential += c.live * (p.finalPrice || 0);
        return { _id: p._id, name: p.name, students: c.live, revenue: c.live * (p.finalPrice || 0), status: p.status };
    }).sort((a, b) => b.students - a.students || a.name.localeCompare(b.name));
    return { ...summary, studentsOnPlans, revenuePotential, perPlan };
};

const getPlanById = async (id, libraryId) => {
    assertId(id);
    const plan = await Plan.findOne({ _id: id, libraryId });
    if (!plan) throw new ApiError(404, 'Plan not found');
    return plan;
};

const getPlanDetail = async (id, libraryId) => {
    const plan = await getPlanById(id, libraryId);
    const counts = await studentCountsFor(libraryId, [plan._id]);
    const [recent, byStatus] = await Promise.all([
        Student.find({ libraryId, planId: plan._id }).select('name mobile planStatus expiryDate').sort({ updatedAt: -1 }).limit(8),
        Student.aggregate([
            { $match: { libraryId: new mongoose.Types.ObjectId(String(libraryId)), isDeleted: false, planId: plan._id } },
            { $group: { _id: '$planStatus', n: { $sum: 1 } } }
        ])
    ]);
    const statusCounts = {};
    byStatus.forEach((r) => { statusCounts[r._id] = r.n; });
    return { ...withCounts(plan, counts), recentStudents: recent, studentStatusCounts: statusCounts };
};

const updatePlanById = async (id, libraryId, body) => {
    const plan = await getPlanById(id, libraryId);
    const data = pick(body, PLAN_FIELDS);
    if (data.name && data.name.trim().toLowerCase() !== plan.name.toLowerCase()) await assertUniqueName(libraryId, data.name, plan._id);
    Object.assign(plan, data);
    if (plan.durationType === 'custom' && !(Number(plan.durationDays) > 0)) {
        throw new ApiError(400, 'durationDays is required for custom plans');
    }
    if ((plan.discount || 0) > plan.price) throw new ApiError(400, 'Discount cannot exceed price');
    await plan.save(); // pre-save recalculates durationDays / finalPrice
    return plan;
};

const updatePlanStatus = async (id, libraryId, status) => {
    const plan = await getPlanById(id, libraryId);
    plan.status = !!status;
    await plan.save();
    return plan;
};

/** Delete a plan only when no student is linked to it; otherwise ask the owner to switch it off instead. */
const deletePlanById = async (id, libraryId) => {
    const plan = await getPlanById(id, libraryId);
    const inUse = await Student.countDocuments({ libraryId, planId: plan._id });
    if (inUse > 0) {
        throw new ApiError(409, `${inUse} student(s) are on this plan. Switch the plan off instead of deleting it.`);
    }
    plan.isDeleted = true;
    await plan.save();
    return { plan };
};

module.exports = {
    createPlan,
    queryPlans,
    buildPlanFilter,
    getPlanSummary,
    getPlanStats,
    getPlanDetail,
    getPlanById,
    updatePlanById,
    updatePlanStatus,
    deletePlanById,
    getPlanDurationDays
};
