const Banner = require('./banner.model');
const ApiError = require('../../utils/ApiError');
const fs = require('fs');

/**
 * Create a banner
 */
const createBanner = async (bannerBody, reqFile) => {
    if (reqFile) {
        bannerBody.image = reqFile.path;
    }
    const banner = await Banner.create(bannerBody);
    return banner;
};

/**
 * Query for banners
 */
const queryBanners = async (filter, options = {}) => {
    const { page = 1, limit = 10, search = '' } = options;
    const skip = (page - 1) * limit;

    const query = { ...filter, isDeleted: false };
    if (search) {
        query.title = { $regex: search, $options: 'i' };
    }

    const banners = await Banner.find(query)
        .populate('createdBy', 'name userType roleId')
        .sort({ displayOrder: 1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

    const totalResults = await Banner.countDocuments(query);
    const totalPages = Math.ceil(totalResults / limit);

    const now = new Date();
    const activeCount = await Banner.countDocuments({ ...filter, isActive: true, endDate: { $gte: now } });
    const expiredCount = await Banner.countDocuments({ ...filter, endDate: { $lt: now } });

    const summary = {
        total: totalResults,
        active: activeCount,
        expired: expiredCount,
        totalViews: 0
    };

    return {
        results: banners,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages,
        totalResults,
        summary
    };
};

/**
 * Get banner by id
 */
const getBannerById = async (id, libraryId) => {
    const banner = await Banner.findOne({ _id: id, libraryId, isDeleted: false });
    if (!banner) {
        throw new ApiError(404, 'Banner not found');
    }
    return banner;
};

/**
 * Update banner by id
 */
const updateBannerById = async (id, libraryId, updateBody, reqFile) => {
    const banner = await getBannerById(id, libraryId);
    
    if (reqFile) {
        // Option to delete old image if required
        // if (banner.image && fs.existsSync(banner.image)) {
        //     fs.unlinkSync(banner.image);
        // }
        updateBody.image = reqFile.path;
    }

    Object.assign(banner, updateBody);
    await banner.save();
    return banner;
};

/**
 * Delete banner by id (Soft Delete)
 */
const deleteBannerById = async (id, libraryId) => {
    const banner = await getBannerById(id, libraryId);
    banner.isDeleted = true;
    await banner.save();
    return banner;
};

module.exports = {
    createBanner,
    queryBanners,
    getBannerById,
    updateBannerById,
    deleteBannerById
};
