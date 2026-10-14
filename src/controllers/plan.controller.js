const catchAsync = require('../utils/catchAsync');
const planService = require('../services/plan.service');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const { tenantId } = require('../middlewares/access.middleware');

const lib = (req) => {
    const id = tenantId(req);
    if (!id) throw new ApiError(400, 'Library ID is required');
    return id;
};

const createPlan = catchAsync(async (req, res) => {
    const plan = await planService.createPlan(lib(req), req.body, req.user._id);
    audit(req, 'plan.create', 'Plan', plan._id, { name: plan.name, price: plan.price });
    res.status(201).json({ success: true, message: 'Plan created successfully', data: plan });
});

const getPlans = catchAsync(async (req, res) => {
    const libraryId = lib(req);
    const filter = planService.buildPlanFilter(libraryId, req.query);
    const result = await planService.queryPlans(filter, { page: req.query.page, limit: req.query.limit });
    const summary = await planService.getPlanSummary(libraryId);

    res.status(200).json({
        success: true,
        message: 'Plans retrieved successfully',
        data: result.results,
        results: result.results,
        total: result.totalResults,
        page: result.page,
        limit: result.limit,
        totalResults: result.totalResults,
        summary
    });
});

const getPlan = catchAsync(async (req, res) => {
    const plan = await planService.getPlanById(req.params.id, lib(req));
    res.status(200).json({ success: true, message: 'Plan retrieved successfully', data: plan });
});

const updatePlan = catchAsync(async (req, res) => {
    const plan = await planService.updatePlanById(req.params.id, lib(req), req.body);
    audit(req, 'plan.update', 'Plan', plan._id, { fields: Object.keys(req.body) });
    res.status(200).json({ success: true, message: 'Plan updated successfully', data: plan });
});

const deletePlan = catchAsync(async (req, res) => {
    const result = await planService.deletePlanById(req.params.id, lib(req));
    audit(req, result.archived ? 'plan.archive' : 'plan.delete', 'Plan', result.plan._id, { activeMembers: result.activeMembers });
    res.status(200).json({
        success: true,
        message: result.archived
            ? `Plan archived because ${result.activeMembers} member(s) still use it`
            : 'Plan deleted successfully',
        archived: result.archived,
        data: result.plan
    });
});

const updatePlanStatus = catchAsync(async (req, res) => {
    const plan = await planService.updatePlanStatus(req.params.id, lib(req), req.body.status);
    audit(req, 'plan.status', 'Plan', plan._id, { status: plan.status });
    res.status(200).json({ success: true, message: 'Plan status updated successfully', data: plan });
});

module.exports = {
    createPlan,
    getPlans,
    getPlan,
    updatePlan,
    deletePlan,
    updatePlanStatus
};
