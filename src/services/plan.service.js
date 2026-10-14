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

const createPlan = async (libraryId, body, createdBy) => {
    const data = pick(body, PLAN_FIELDS);
    if (data.durationType === 'custom' && !(Number(data.durationDays) > 0)) {
        throw new ApiError(400, 'durationDays is required for custom plans');
    }
    return Plan.create({ ...data, libraryId, createdBy });
};

const queryPlans = async (filter, options = {}) => {
    const page = Math.max(parseInt(options.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(options.limit) || 100, 1), 200);
    const skip = (page - 1) * limit;

    const [plans, totalResults] = await Promise.all([
        Plan.find(filter)
            .populate({ path: 'createdBy', select: 'name userType roleId', populate: { path: 'roleId', select: 'name' } })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Plan.countDocuments(filter)
    ]);

    return { results: plans, page, limit, totalResults };
};

const buildPlanFilter = (libraryId, { search, status, archived } = {}) => {
    const filter = { libraryId, isDeleted: false };
    filter.isArchived = archived === 'true' ? true : { $ne: true };
    if (status) {
        const s = String(status).toLowerCase();
        if (s === 'active') filter.status = true;
        else if (s === 'inactive') filter.status = false;
    }
    if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };
    return filter;
};

const getPlanSummary = async (libraryId) => {
    const base = { libraryId, isDeleted: false, isArchived: { $ne: true } };
    const [total, active, inactive, archived] = await Promise.all([
        Plan.countDocuments(base),
        Plan.countDocuments({ ...base, status: true }),
        Plan.countDocuments({ ...base, status: false }),
        Plan.countDocuments({ libraryId, isDeleted: false, isArchived: true })
    ]);
    return { total, active, inactive, archived };
};

const getPlanById = async (id, libraryId) => {
    assertId(id);
    const plan = await Plan.findOne({ _id: id, libraryId });
    if (!plan) throw new ApiError(404, 'Plan not found');
    return plan;
};

const updatePlanById = async (id, libraryId, body) => {
    const plan = await getPlanById(id, libraryId);
    const data = pick(body, PLAN_FIELDS);
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

/**
 * Delete a plan. If students still hold an active/pending/paused membership on it,
 * the plan is archived (hidden, not assignable) instead of removed.
 */
const deletePlanById = async (id, libraryId) => {
    const plan = await getPlanById(id, libraryId);
    const inUse = await Student.countDocuments({ libraryId, planId: plan._id, planStatus: { $in: LIVE_MEMBERSHIP } });
    if (inUse > 0) {
        plan.isArchived = true;
        plan.status = false;
        await plan.save();
        return { plan, archived: true, activeMembers: inUse };
    }
    plan.isDeleted = true;
    await plan.save();
    return { plan, archived: false, activeMembers: 0 };
};

module.exports = {
    createPlan,
    queryPlans,
    buildPlanFilter,
    getPlanSummary,
    getPlanById,
    updatePlanById,
    updatePlanStatus,
    deletePlanById,
    getPlanDurationDays
};
