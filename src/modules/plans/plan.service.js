const Plan = require('./plan.model');
const httpStatus = require('http-status');
const ApiError = require('../../utils/ApiError');

/**
 * Create a plan
 * @param {Object} planBody
 * @returns {Promise<Plan>}
 */
const createPlan = async (planBody) => {
    return Plan.create(planBody);
};

/**
 * Query for plans
 * @param {Object} filter - Mongo filter
 * @returns {Promise<QueryResult>}
 */
const queryPlans = async (filter, options = {}) => {
    const { page = 1, limit = 100 } = options;
    const skip = (page - 1) * limit;

    const plans = await Plan.find(filter)
        .populate({
            path: 'createdBy',
            select: 'name userType roleId',
            populate: { path: 'roleId', select: 'name' }
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

    const totalResults = await Plan.countDocuments(filter);

    return {
        results: plans,
        page: parseInt(page),
        limit: parseInt(limit),
        totalResults
    };
};

/**
 * Get plan by id
 * @param {ObjectId} id
 * @returns {Promise<Plan>}
 */
const getPlanById = async (id) => {
    return Plan.findById(id);
};

/**
 * Update plan by id
 * @param {ObjectId} planId
 * @param {Object} updateBody
 * @returns {Promise<Plan>}
 */
const updatePlanById = async (planId, updateBody) => {
    const plan = await getPlanById(planId);
    if (!plan) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Plan not found');
    }
    Object.assign(plan, updateBody);
    await plan.save();
    return plan;
};

/**
 * Delete plan by id
 * @param {ObjectId} planId
 * @returns {Promise<Plan>}
 */
const deletePlanById = async (planId) => {
    const plan = await getPlanById(planId);
    if (!plan) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Plan not found');
    }
    plan.isDeleted = true;
    await plan.save();
    return plan;
};

module.exports = {
    createPlan,
    queryPlans,
    getPlanById,
    updatePlanById,
    deletePlanById,
};
