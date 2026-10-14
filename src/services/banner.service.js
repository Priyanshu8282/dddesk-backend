const mongoose = require('mongoose');
const Banner = require('../models/banner.model');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');
const pick = require('../utils/pick');
const { branchVisibility } = require('../utils/branchScope');
const { startOfDayIST, endOfDayIST } = require('../utils/time');

// 'YYYY-MM-DD' (date-only) means the whole IST day; full timestamps are kept as given
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const parseStart = (v) => (DATE_ONLY.test(String(v)) ? startOfDayIST(new Date(v)) : new Date(v));
const parseEnd = (v) => (DATE_ONLY.test(String(v)) ? endOfDayIST(new Date(v)) : new Date(v));

const FIELDS = ['title', 'description', 'bannerType', 'ctaText', 'ctaUrl', 'displayLocation', 'displayOrder', 'priority', 'isActive', 'branchId']; // branchId validated by the controller (null = all branches)

const assertId = (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid banner ID');
};

const checkDates = (start, end) => {
    if (start && end && new Date(start) > new Date(end)) throw new ApiError(400, 'End date must not be before the start date');
};

// Banner image must be a real image
const imagePath = (file) => {
    if (!file) return undefined;
    if (file.mediaKind !== 'image') throw new ApiError(400, 'Banner must be an image');
    return file.path;
};

const createBanner = async (libraryId, body, file, creatorId) => {
    const data = pick(body, FIELDS);
    if (body.redirectUrl && !data.ctaUrl) data.ctaUrl = body.redirectUrl; // legacy field
    data.redirectUrl = data.ctaUrl;
    data.startDate = parseStart(body.startDate);
    data.endDate = parseEnd(body.endDate);
    checkDates(data.startDate, data.endDate);
    const image = imagePath(file);
    if (!image) throw new ApiError(400, 'Image is required for banner');
    return Banner.create({ ...data, image, libraryId, createdBy: creatorId });
};

const sortSpec = { priority: -1, displayOrder: 1, createdAt: -1 };

// `scope` = branch filter fragment from utils/branchScope.branchFilter(req): banners of those branches + all-branch banners
const queryBanners = async (libraryId, { page = 1, limit = 10, search = '' } = {}, scope = {}) => {
    const now = new Date();
    const query = { libraryId };
    if (scope.branchId) query.$and = [{ $or: [{ branchId: null }, scope] }];
    if (search) query.title = new RegExp(escapeRegex(String(search).trim()), 'i');

    const p = Math.max(parseInt(page, 10) || 1, 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
    const [banners, totalResults, active, expired] = await Promise.all([
        Banner.find(query).populate('createdBy', 'name userType').sort(sortSpec).skip((p - 1) * l).limit(l).lean(),
        Banner.countDocuments(query),
        Banner.countDocuments({ libraryId, isActive: true, startDate: { $lte: now }, endDate: { $gte: now } }),
        Banner.countDocuments({ libraryId, endDate: { $lt: now } })
    ]);
    return {
        results: banners, page: p, limit: l, totalPages: Math.ceil(totalResults / l), totalResults,
        summary: { total: totalResults, active, expired, totalViews: 0 }
    };
};

const getBannerById = async (id, libraryId) => {
    assertId(id);
    const banner = await Banner.findOne({ _id: id, libraryId });
    if (!banner) throw new ApiError(404, 'Banner not found');
    return banner;
};

const updateBannerById = async (id, libraryId, body, file) => {
    const banner = await getBannerById(id, libraryId);
    const set = pick(body, FIELDS);
    if (body.redirectUrl && body.ctaUrl === undefined) set.ctaUrl = body.redirectUrl;
    if (set.ctaUrl !== undefined) set.redirectUrl = set.ctaUrl;
    if (body.startDate) set.startDate = parseStart(body.startDate);
    if (body.endDate) set.endDate = parseEnd(body.endDate);
    checkDates(set.startDate || banner.startDate, set.endDate || banner.endDate);
    const image = imagePath(file);
    if (image) set.image = image;
    banner.set(set);
    await banner.save();
    return banner;
};

const toggleBanner = async (id, libraryId) => {
    assertId(id);
    const banner = await Banner.findOneAndUpdate({ _id: id, libraryId }, [{ $set: { isActive: { $not: '$isActive' } } }], { new: true });
    if (!banner) throw new ApiError(404, 'Banner not found');
    return banner;
};

const deleteBannerById = async (id, libraryId) => {
    assertId(id);
    const banner = await Banner.findOneAndUpdate({ _id: id, libraryId }, { $set: { isDeleted: true, isActive: false } }, { new: true });
    if (!banner) throw new ApiError(404, 'Banner not found');
    return banner;
};

/**
 * Banners currently live for a library, highest priority first.
 * location: 'website' | 'app' (banners marked 'both' always match); omit for any.
 * Safe to call from public (unauthenticated) code: only presentation fields are returned.
 */
// branchId: undefined = no branch filter; null = only all-branch banners; id = all-branch + that branch's banners
const getActiveBanners = async (libraryId, location, branchId) => {
    if (!libraryId || !mongoose.Types.ObjectId.isValid(libraryId)) return [];
    const now = new Date();
    const filter = {
        libraryId, isActive: true, startDate: { $lte: now }, endDate: { $gte: now }
    };
    if (location === 'website' || location === 'app') filter.displayLocation = { $in: [location, 'both'] };
    if (branchId !== undefined) filter.$and = [branchVisibility(branchId)];
    return Banner.find(filter)
        .select('title description bannerType image ctaText ctaUrl redirectUrl displayLocation priority displayOrder startDate endDate')
        .sort(sortSpec).lean();
};

module.exports = {
    createBanner, queryBanners, getBannerById, updateBannerById, toggleBanner, deleteBannerById, getActiveBanners
};
