const bannerService = require('../services/banner.service');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');

const createBanner = catchAsync(async (req, res) => {
    if (!req.user || !req.user.libraryId) {
        throw new ApiError(400, "Library ID is required");
    }
    
    req.body.libraryId = req.user.libraryId;
    req.body.createdBy = req.user.id;

    if (!req.file && !req.body.image) {
        throw new ApiError(400, "Image is required for banner");
    }

    const banner = await bannerService.createBanner(req.body, req.file);
    res.status(201).json({ success: true, message: "Banner created successfully", data: banner });
});

const getBanners = catchAsync(async (req, res) => {
    if (!req.user || !req.user.libraryId) {
        throw new ApiError(400, "Library ID is required");
    }

    const filter = { libraryId: req.user.libraryId };
    const options = {
        page: req.query.page,
        limit: req.query.limit,
        search: req.query.search
    };

    const result = await bannerService.queryBanners(filter, options);
    res.status(200).json({
        success: true,
        message: "Banners retrieved successfully",
        data: result.results || result,
        ...result
    });
});

const getBannerById = catchAsync(async (req, res) => {
    const banner = await bannerService.getBannerById(req.params.id, req.user.libraryId);
    res.status(200).json({
        success: true,
        message: "Banner retrieved successfully",
        data: banner
    });
});

const updateBanner = catchAsync(async (req, res) => {
    const banner = await bannerService.updateBannerById(req.params.id, req.user.libraryId, req.body, req.file);
    res.status(200).json({ success: true, message: "Banner updated successfully", data: banner });
});

const deleteBanner = catchAsync(async (req, res) => {
    await bannerService.deleteBannerById(req.params.id, req.user.libraryId);
    res.status(200).json({ success: true, message: "Banner deleted successfully" });
});

const toggleBanner = catchAsync(async (req, res) => {
    const banner = await bannerService.getBannerById(req.params.id, req.user.libraryId);
    if (!banner) {
        throw new ApiError(404, "Banner not found");
    }
    banner.isActive = !banner.isActive;
    await banner.save();
    res.status(200).json({
        success: true,
        message: `Banner ${banner.isActive ? 'activated' : 'deactivated'} successfully`,
        data: banner
    });
});

module.exports = {
    createBanner,
    getBanners,
    getBannerById,
    updateBanner,
    deleteBanner,
    toggleBanner
};
