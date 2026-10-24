const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const { tenantId } = require('../middlewares/access.middleware');
const { resolveTenantById, sendTenantError } = require('../middlewares/publicLibrary.middleware');
const svc = require('../services/website.service');

const ok = (res, data, message = 'Success', status = 200) =>
    res.status(status).json({ success: true, message, data });

const libId = (req) => {
    const id = tenantId(req);
    if (!id) throw new ApiError(400, 'Library context required');
    return id;
};

// ---------------- private (owner / staff) ----------------
exports.getSettings = catchAsync(async (req, res) => {
    ok(res, await svc.getWebsiteSettings(libId(req)), 'Website settings retrieved successfully');
});

exports.updateSettings = catchAsync(async (req, res) => {
    const doc = await svc.updateWebsiteSettings(libId(req), req.body);
    audit(req, 'website.update', 'LibraryWebsite', doc._id, { fields: Object.keys(req.body), isPublished: doc.isPublished });
    ok(res, doc, 'Website settings saved successfully');
});

// ---------------- public ----------------
const cacheable = (res, seconds = 60) => res.set('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=120`);

exports.getPublicProfile = catchAsync(async (req, res) => {
    const tenant = await resolveTenantById(req.params.libraryId);
    if (tenant.reason) return sendTenantError(res, tenant);
    cacheable(res);
    tenant.branchId = publicBranch(req);
    ok(res, await svc.getPublicSite(tenant), 'Public profile retrieved successfully');
});

// Optional ?branchId= on public pages: branch content + all-branch content (default: all-branch content only)
const publicBranch = (req) => (require('../utils/branchScope').isValidId(req.query.branchId) ? String(req.query.branchId) : null);

const section = (fn, key) => catchAsync(async (req, res) => {
    cacheable(res);
    req.tenant.branchId = publicBranch(req);
    ok(res, { [key]: await svc[fn](req.tenant) }, `Public ${key} retrieved successfully`);
});

exports.getPlans = section('getPublicPlans', 'plans');
exports.getSeats = section('getPublicSeats', 'seatAvailability');
exports.getStories = section('getPublicStories', 'stories');
exports.getNotices = section('getPublicNotices', 'notices');
exports.getBanners = section('getPublicBanners', 'banners');
exports.getOffers = section('getPublicOffers', 'offers');
exports.getGallery = section('getPublicGallery', 'gallery');

exports.getReviews = catchAsync(async (req, res) => {
    cacheable(res);
    ok(res, await svc.getPublicReviews(req.tenant), 'Public reviews retrieved successfully');
});

const THANKS = 'Thank you! The library will contact you shortly.';

exports.submitEnquiry = catchAsync(async (req, res) => {
    // Honeypot: bots fill hidden fields. Pretend success, store nothing.
    if (req.body.website || req.body.hp) return ok(res, { received: true }, THANKS, 201);
    const result = await svc.createPublicEnquiry(req.tenant.library, req.body, req.ip);
    ok(res, { received: true, id: result.id }, THANKS, 201);
});

// POST /public/website/enquiry with { libraryId, ... }
exports.submitEnquiryByBody = catchAsync(async (req, res) => {
    if (req.body.website || req.body.hp) return ok(res, { received: true }, THANKS, 201);
    const lib = await svc.findActiveLibraryForEnquiry({ libraryId: req.body.libraryId });
    const result = await svc.createPublicEnquiry(lib, req.body, req.ip);
    ok(res, { received: true, id: result.id }, THANKS, 201);
});
