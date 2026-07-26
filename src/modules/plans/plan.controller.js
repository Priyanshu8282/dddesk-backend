const catchAsync = require('../../utils/catchAsync');
const planService = require('./plan.service');
const ApiError = require('../../utils/ApiError');
const Plan = require('./plan.model');

const createPlan = catchAsync(async (req, res) => {
    const planBody = {
        ...req.body,
        libraryId: req.user.libraryId || req.body.libraryId, // Use libraryId from user or body
        createdBy: req.user._id
    };
    
    if (!planBody.libraryId) {
        throw new ApiError(400, 'Library ID is required');
    }

    const plan = await planService.createPlan(planBody);
    res.status(201).json({
        success: true,
        message: 'Plan created successfully',
        data: plan
    });
});

const getPlans = catchAsync(async (req, res) => {
    const { search = '', status = '', page = 1, limit = 10 } = req.query;
    const filter = { isDeleted: false };
    
    // If not superadmin, only show plans for their library
    if (req.user.userType !== 'superadmin') {
        filter.libraryId = req.user.libraryId;
    } else if (req.query.libraryId) {
        filter.libraryId = req.query.libraryId;
    }
    
    if (status) {
        const statusLower = status.toLowerCase();
        if (statusLower === 'active') {
            filter.status = true;
        } else if (statusLower === 'inactive') {
            filter.status = false;
        }
    }
    
    if (search) {
        filter.name = { $regex: search, $options: 'i' };
    }
    
    const result = await planService.queryPlans(filter, { page, limit });
    
    // Calculate summary statistics
    const summaryFilter = { isDeleted: false };
    if (req.user.userType !== 'superadmin') {
        summaryFilter.libraryId = req.user.libraryId;
    } else if (req.query.libraryId) {
        summaryFilter.libraryId = req.query.libraryId;
    }
    
    const totalCount = await Plan.countDocuments(summaryFilter);
    const activeCount = await Plan.countDocuments({ ...summaryFilter, status: true });
    const inactiveCount = await Plan.countDocuments({ ...summaryFilter, status: false });
    
    const summary = {
        total: totalCount,
        active: activeCount,
        inactive: inactiveCount
    };
    
    res.status(200).json({
        success: true,
        message: 'Plans fetched successfully',
        data: result.results,
        results: result.results,
        page: result.page,
        limit: result.limit,
        totalResults: result.totalResults,
        summary
    });
});

const getPlan = catchAsync(async (req, res) => {
    const plan = await planService.getPlanById(req.params.planId);
    if (!plan) {
        throw new ApiError(404, 'Plan not found');
    }
    res.status(200).json({
        success: true,
        message: 'Plan fetched successfully',
        data: plan
    });
});

const updatePlan = catchAsync(async (req, res) => {
    const plan = await planService.updatePlanById(req.params.planId, req.body);
    res.status(200).json({
        success: true,
        message: 'Plan updated successfully',
        data: plan
    });
});

const deletePlan = catchAsync(async (req, res) => {
    await planService.deletePlanById(req.params.planId);
    res.status(204).send();
});

const updatePlanStatus = catchAsync(async (req, res) => {
    const { status } = req.body;
    const plan = await planService.updatePlanById(req.params.planId, { status });
    res.status(200).json({
        success: true,
        message: 'Plan status updated successfully',
        data: plan
    });
});

module.exports = {
    createPlan,
    getPlans,
    getPlan,
    updatePlan,
    deletePlan,
    updatePlanStatus,
};
