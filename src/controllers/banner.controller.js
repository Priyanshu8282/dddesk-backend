const bannerService = require('../services/banner.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/ApiResponse');
const audit = require('../utils/audit');
const { branchFilter, branchForCreate } = require('../utils/branchScope');

const createBanner = catchAsync(async (req, res) => {
    req.body.branchId = await branchForCreate(req, req.libraryId, req.body.branchId);
    const banner = await bannerService.createBanner(req.libraryId, req.body, req.file, req.user._id);
    audit(req, 'banner.create', 'Banner', banner._id);
    ApiResponse.created(res, banner, 'Banner created successfully');
});

const getBanners = catchAsync(async (req, res) => {
    const result = await bannerService.queryBanners(req.libraryId, req.query, branchFilter(req));
    ApiResponse.ok(res, result.results, 'Banners retrieved successfully', {
        results: result.results, page: result.page, limit: result.limit,
        totalPages: result.totalPages, totalResults: result.totalResults, summary: result.summary
    });
});

// Student / app: only live, in-date banners of the caller's library
const getActiveBanners = catchAsync(async (req, res) => {
    const banners = await bannerService.getActiveBanners(req.libraryId, req.query.location || 'app', req.userType === 'student' ? (req.user.branchId || null) : undefined);
    ApiResponse.ok(res, banners, 'Active banners retrieved successfully');
});

const getBannerById = catchAsync(async (req, res) => {
    const banner = await bannerService.getBannerById(req.params.id, req.libraryId);
    ApiResponse.ok(res, banner, 'Banner retrieved successfully');
});

const updateBanner = catchAsync(async (req, res) => {
    if (req.body.branchId !== undefined) req.body.branchId = await branchForCreate(req, req.libraryId, req.body.branchId);
    const banner = await bannerService.updateBannerById(req.params.id, req.libraryId, req.body, req.file);
    audit(req, 'banner.update', 'Banner', banner._id);
    ApiResponse.ok(res, banner, 'Banner updated successfully');
});

const deleteBanner = catchAsync(async (req, res) => {
    const banner = await bannerService.deleteBannerById(req.params.id, req.libraryId);
    audit(req, 'banner.delete', 'Banner', banner._id);
    ApiResponse.ok(res, null, 'Banner deleted successfully');
});

const toggleBanner = catchAsync(async (req, res) => {
    const banner = await bannerService.toggleBanner(req.params.id, req.libraryId);
    audit(req, 'banner.toggle', 'Banner', banner._id, { isActive: banner.isActive });
    ApiResponse.ok(res, banner, `Banner ${banner.isActive ? 'activated' : 'deactivated'} successfully`);
});

module.exports = {
    createBanner,
    getBanners,
    getActiveBanners,
    getBannerById,
    updateBanner,
    deleteBanner,
    toggleBanner
};
