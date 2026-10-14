const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const { tenantId } = require('../middlewares/access.middleware');
const { resolveTenantFromHost, resolveTenantBySlug, sendTenantError } = require('../middlewares/tenantHost.middleware');
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

exports.requestCustomDomain = catchAsync(async (req, res) => {
    const data = await svc.requestCustomDomain(libId(req), req.body.domain);
    audit(req, 'website.customDomain.request', 'Library', libId(req), { domain: req.body.domain });
    ok(res, data, 'Add the TXT record shown below to your DNS, then verify', 201);
});

exports.getCustomDomain = catchAsync(async (req, res) => {
    ok(res, await svc.getCustomDomainStatus(libId(req)), 'Custom domain status retrieved');
});

exports.verifyCustomDomain = catchAsync(async (req, res) => {
    const data = await svc.verifyCustomDomain(libId(req));
    audit(req, 'website.customDomain.verify', 'Library', libId(req), { domain: data.domain });
    ok(res, data, 'Custom domain verified');
});

exports.removeCustomDomain = catchAsync(async (req, res) => {
    const data = await svc.removeCustomDomain(libId(req));
    audit(req, 'website.customDomain.remove', 'Library', libId(req));
    ok(res, data, 'Custom domain removed');
});

exports.changeSlug = catchAsync(async (req, res) => {
    const data = await svc.changeSlug(libId(req), req.body.slug);
    audit(req, 'website.slug.change', 'Library', libId(req), { from: data.oldSlug, to: data.slug });
    ok(res, data, 'Website address updated. The old address will redirect.');
});

// ---------------- public ----------------
const cacheable = (res, seconds = 60) => res.set('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=120`);

exports.resolveTenant = catchAsync(async (req, res) => {
    // ?host= is used by the frontend edge/middleware; otherwise the Host header / x-tenant-slug
    const t = await resolveTenantFromHost(req, { host: req.query.host });
    if (t.reason) return sendTenantError(res, t);
    cacheable(res, 30);
    ok(res, svc.getTenantSummary(t), 'Tenant resolved');
});

exports.getPublicProfile = catchAsync(async (req, res) => {
    const tenant = await resolveTenantBySlug(req.params.slug);
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

// Legacy: POST /public/website/enquiry with { slug | libraryId, ... }
exports.submitEnquiryLegacy = catchAsync(async (req, res) => {
    if (req.body.website || req.body.hp) return ok(res, { received: true }, THANKS, 201);
    const lib = await svc.findActiveLibraryForEnquiry({ slug: req.body.slug, libraryId: req.body.libraryId });
    const result = await svc.createPublicEnquiry(lib, req.body, req.ip);
    ok(res, { received: true, id: result.id }, THANKS, 201);
});
