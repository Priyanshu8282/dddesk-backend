const mongoose = require('mongoose');
const LibraryWebsite = require('../models/libraryWebsite.model');
const Library = require('../models/library.model');
const Plan = require('../models/plan.model');
const Story = require('../models/story.model');
const Notice = require('../models/notice.model');
const Banner = require('../models/banner.model');
const Coupon = require('../models/coupon.model');
const Review = require('../models/review.model');
const Seat = require('../models/seat.model');
const Enquiry = require('../models/enquiry.model');
const ApiError = require('../utils/ApiError');
const pick = require('../utils/pick');
const { branchVisibility, resolveBranch } = require('../utils/branchScope');
const { resolveTenantById } = require('../middlewares/publicLibrary.middleware');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const lazy = (modPath) => { try { return require(modPath); } catch (e) { return null; } };
const hasPath = (Model, p) => !!Model.schema.path(p);
const oid = (v) => new mongoose.Types.ObjectId(String(v));

// Fields from Library that are safe on a public page (never password/roleId/owner internals)
const PUBLIC_LIBRARY_FIELDS = 'name address city state country pincode logo profileImage photos workingHours mobile alternativeMobileNumber email website';
const SETTINGS_LIBRARY_FIELDS = 'name ownerName email mobile address city state pincode logo profileImage photos workingHours website';

// Flatten nested plain objects into dotted $set keys so partial updates do not wipe siblings
const flatten = (obj, prefix = '', out = {}) => {
    Object.entries(obj).forEach(([k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) flatten(v, key, out);
        else out[key] = v;
    });
    return out;
};

// ---------------------------------------------------------------------------
// private settings (owner / staff)
// ---------------------------------------------------------------------------

exports.getWebsiteSettings = async (libraryId) => {
    let doc = await LibraryWebsite.findOne({ libraryId }).lean();
    if (!doc) doc = (await LibraryWebsite.create({ libraryId })).toObject();
    const library = await Library.findById(libraryId).select(SETTINGS_LIBRARY_FIELDS).lean();
    return { ...doc, library };
};

const SETTINGS_FIELDS = [
    'about', 'announcement', 'facilities', 'gallery', 'openingHours', 'weeklyHolidays', 'rules', 'terms',
    'socialLinks', 'theme', 'location', 'seo', 'showSeatAvailability', 'showStories', 'showNotices',
    'showPlans', 'showReviews', 'isPublished'
];

exports.updateWebsiteSettings = async (libraryId, body) => {
    const data = pick(body, SETTINGS_FIELDS);
    const update = flatten(data);
    if (!Object.keys(update).length) throw new ApiError(400, 'No valid fields to update');
    const doc = await LibraryWebsite.findOneAndUpdate(
        { libraryId }, { $set: update, $setOnInsert: { libraryId } },
        { new: true, upsert: true, runValidators: true }
    ).lean();
    return doc;
};

// ---------------------------------------------------------------------------
// public data builders (all take a resolved tenant: { library, website })
// ---------------------------------------------------------------------------
const activeWindow = (Model, now, startFields, endFields) => {
    const and = [];
    for (const f of startFields) {
        if (hasPath(Model, f)) { and.push({ $or: [{ [f]: { $exists: false } }, { [f]: null }, { [f]: { $lte: now } }] }); break; }
    }
    for (const f of endFields) {
        if (hasPath(Model, f)) { and.push({ $or: [{ [f]: { $exists: false } }, { [f]: null }, { [f]: { $gte: now } }] }); break; }
    }
    return and;
};

const isEnabled = (website, flag) => (website ? website[flag] !== false : true);

exports.getPublicPlans = async (tenant) => {
    if (!isEnabled(tenant.website, 'showPlans')) return [];
    const plans = await Plan.find({ libraryId: tenant.library._id, status: { $ne: false }, isDeleted: { $ne: true }, isArchived: { $ne: true } })
        .select('name description durationType durationDays price discount finalPrice features seatTypes depositAmount joiningFee')
        .sort({ price: 1 }).limit(50).lean();
    return plans.map((p) => ({
        id: p._id, name: p.name, description: p.description || '', durationType: p.durationType,
        durationDays: p.durationDays, price: p.price, discount: p.discount || 0,
        finalPrice: p.finalPrice ?? Math.max(0, p.price - (p.discount || 0)),
        features: p.features || [], seatTypes: p.seatTypes || [],
        depositAmount: p.depositAmount || 0, joiningFee: p.joiningFee || 0
    }));
};

exports.getPublicSeats = async (tenant) => {
    if (!isEnabled(tenant.website, 'showSeatAvailability')) return null;
    const seatSvc = lazy('./seat.service');
    if (seatSvc && typeof seatSvc.getPublicAvailability === 'function') {
        try { return await seatSvc.getPublicAvailability(tenant.library._id, tenant.branchId ? { branchId: new mongoose.Types.ObjectId(String(tenant.branchId)) } : {}); } catch (e) { /* fall through to direct query */ }
    }
    const rows = await Seat.aggregate([
        { $match: { libraryId: oid(tenant.library._id), isDeleted: false, ...(tenant.branchId ? { branchId: oid(tenant.branchId) } : {}) } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const m = {};
    rows.forEach((r) => { m[r._id] = r.count; });
    const total = rows.reduce((a, r) => a + r.count, 0);
    const unavailable = (m.blocked || 0) + (m.maintenance || 0);
    return {
        total, available: m.available || 0, occupied: m.occupied || 0, reserved: m.reserved || 0,
        unavailable, bookable: total - unavailable,
        updatedAt: new Date()
    };
};

exports.getPublicStories = async (tenant) => {
    if (!isEnabled(tenant.website, 'showStories')) return [];
    const stories = await Story.find({ libraryId: tenant.library._id, isActive: true, archived: { $ne: true }, publishAt: { $lte: new Date() }, expiresAt: { $gt: new Date() }, ...branchVisibility(tenant.branchId) })
        .select('title description type url createdAt expiresAt').sort({ createdAt: -1 }).limit(20).lean();
    return stories.map((s) => ({ id: s._id, title: s.title, description: s.description || '', type: s.type, url: s.url, createdAt: s.createdAt, expiresAt: s.expiresAt }));
};

exports.getPublicNotices = async (tenant) => {
    if (!isEnabled(tenant.website, 'showNotices')) return [];
    const now = new Date();
    const filter = { libraryId: tenant.library._id, isActive: true };
    const and = activeWindow(Notice, now, ['startDate', 'publishDate'], ['endDate', 'expiryDate', 'expiresAt']);
    // Public audience only: notices are student-facing unless explicitly marked public
    if (hasPath(Notice, 'showOnWebsite')) filter.showOnWebsite = true;
    else if (hasPath(Notice, 'isPublic')) filter.isPublic = true;
    else return [];
    filter.$and = [...and, branchVisibility(tenant.branchId)];
    const notices = await Notice.find(filter).select('title description type imageUrl isPinned publishDate createdAt')
        .sort({ isPinned: -1, createdAt: -1 }).limit(20).lean();
    return notices.map((n) => ({ id: n._id, title: n.title, description: n.description || '', type: n.type, imageUrl: n.imageUrl || null, isPinned: !!n.isPinned, publishDate: n.publishDate || n.createdAt }));
};

exports.getPublicBanners = async (tenant) => {
    const bannerSvc = lazy('./banner.service');
    let banners;
    if (bannerSvc && typeof bannerSvc.getActiveBanners === 'function') {
        try { banners = await bannerSvc.getActiveBanners(tenant.library._id, 'website', tenant.branchId || null); } catch (e) { banners = null; }
    }
    if (!Array.isArray(banners)) {
        const now = new Date();
        const filter = { libraryId: tenant.library._id, isActive: true, startDate: { $lte: now }, endDate: { $gte: now }, ...branchVisibility(tenant.branchId) };
        if (hasPath(Banner, 'displayLocation')) filter.displayLocation = { $in: ['website', 'both'] };
        else if (hasPath(Banner, 'location')) filter.location = { $in: ['website', 'both'] };
        banners = await Banner.find(filter).sort({ displayOrder: 1 }).limit(20).lean();
    }
    return banners.map((b) => {
        const o = typeof b.toObject === 'function' ? b.toObject() : b;
        return { id: o._id, title: o.title, description: o.description || '', bannerType: o.bannerType, image: o.image, redirectUrl: o.redirectUrl || null, ctaText: o.ctaText || null, ctaUrl: o.ctaUrl || null, displayOrder: o.displayOrder };
    });
};

exports.getPublicOffers = async (tenant) => {
    const now = new Date();
    const filter = {
        libraryId: tenant.library._id, isActive: true,
        startDate: { $lte: now }, endDate: { $gte: now },
        showOnWebsite: true, isDeleted: { $ne: true }
    };
    const offers = await Coupon.find(filter)
        .select('title code description discountType discountValue maxDiscountAmount minOrderAmount offerType startDate endDate usageLimit usageCount')
        .sort({ endDate: 1 }).limit(20).lean();
    return offers
        .filter((c) => c.usageLimit == null || (c.usageCount || 0) < c.usageLimit)
        .map((c) => ({
            id: c._id, title: c.title, code: c.code, description: c.description || '', offerType: c.offerType,
            discountType: c.discountType, discountValue: c.discountValue, maxDiscountAmount: c.maxDiscountAmount,
            minOrderAmount: c.minOrderAmount || 0, startDate: c.startDate, endDate: c.endDate
        }));
};

exports.getPublicGallery = async (tenant) => {
    const w = tenant.website || {};
    return (w.gallery || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((g) => ({ id: g._id, url: g.url, caption: g.caption || '' }));
};

exports.getPublicReviews = async (tenant) => {
    if (!isEnabled(tenant.website, 'showReviews')) return { averageRating: 0, totalReviews: 0, reviews: [] };
    const libraryId = tenant.library._id;
    const [list, agg] = await Promise.all([
        Review.find({ libraryId, status: 'approved', type: 'public' }).sort({ isFeatured: -1, createdAt: -1 }).limit(20)
            .select('studentName isAnonymous rating review isFeatured ownerReply.text ownerReply.repliedAt createdAt').lean(),
        Review.aggregate([
            { $match: { libraryId: oid(libraryId), status: 'approved', type: 'public', isDeleted: { $ne: true } } },
            { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
        ])
    ]);
    return {
        averageRating: agg[0] ? Math.round(agg[0].avg * 10) / 10 : 0,
        totalReviews: agg[0]?.count || 0,
        reviews: list.map((r) => ({
            id: r._id,
            name: r.isAnonymous ? 'Verified Member' : (r.studentName || 'Verified Member'),
            rating: r.rating, review: r.review, isFeatured: !!r.isFeatured,
            ownerReply: r.ownerReply?.text ? { text: r.ownerReply.text, repliedAt: r.ownerReply.repliedAt } : null,
            createdAt: r.createdAt
        }))
    };
};

const publicBranding = (library, website) => ({
    name: library.name,
    logo: website?.theme?.logo || library.logo || null,
    profileImage: library.profileImage || null,
    theme: {
        primaryColor: website?.theme?.primaryColor || '',
        secondaryColor: website?.theme?.secondaryColor || '',
        accentColor: website?.theme?.accentColor || '',
        fontFamily: website?.theme?.fontFamily || '',
        heroImage: website?.theme?.heroImage || '',
        layout: website?.theme?.layout || 'default'
    }
});

exports.getTenantSummary = (tenant) => {
    const { library, website } = tenant;
    return {
        libraryId: library._id,
        name: library.name,
        branding: publicBranding(library, website),
        isPublished: !!website?.isPublished,
        status: library.status
    };
};

const buildSeo = (library, website) => {
    const about = (website?.about || '').replace(/\s+/g, ' ').trim();
    const place = [library.city, library.state].filter(Boolean).join(', ');
    return {
        title: website?.seo?.title || `${library.name}${place ? ` - Study Library in ${place}` : ''}`,
        description: website?.seo?.description || about.slice(0, 160) || `${library.name} study library${place ? ` in ${place}` : ''}. View plans, facilities and seat availability.`,
        ogImage: website?.seo?.ogImage || website?.theme?.heroImage || library.logo || null
    };
};

/** Resolve (active + published) tenant by library id or throw a coded ApiError. */
exports.requireTenant = async (rawId) => {
    const t = await resolveTenantById(rawId);
    if (t.reason) {
        const e = new ApiError(t.status, t.message);
        e.errorCode = t.reason;
        throw e;
    }
    return t;
};

exports.getPublicSite = async (tenant) => {
    const { library, website } = tenant;
    const [plans, seats, stories, notices, banners, offers, reviews, gallery, full] = await Promise.all([
        exports.getPublicPlans(tenant), exports.getPublicSeats(tenant), exports.getPublicStories(tenant),
        exports.getPublicNotices(tenant), exports.getPublicBanners(tenant), exports.getPublicOffers(tenant),
        exports.getPublicReviews(tenant), exports.getPublicGallery(tenant),
        Library.findById(library._id).select(PUBLIC_LIBRARY_FIELDS).lean()
    ]);
    const w = website || {};
    const holidays = (w.weeklyHolidays && w.weeklyHolidays.length) ? w.weeklyHolidays
        : (w.openingHours?.weeklyHoliday && w.openingHours.weeklyHoliday !== 'None' ? [w.openingHours.weeklyHoliday] : []);
    return {
        profile: {
            libraryId: full._id, name: full.name,
            address: full.address || '', city: full.city || '', state: full.state || '', country: full.country || '', pincode: full.pincode || '',
            photos: full.photos || [], website: full.website || ''
        },
        branding: publicBranding(full, w),
        about: w.about || '',
        announcement: w.announcement || '',
        facilities: w.facilities || [],
        gallery,
        openingHours: {
            openingTime: w.openingHours?.openingTime || full.workingHours?.openingTime || '',
            closingTime: w.openingHours?.closingTime || full.workingHours?.closingTime || '',
            openDays: w.openingHours?.openDays || full.workingHours?.openDays || ''
        },
        weeklyHolidays: holidays,
        rules: w.rules || '',
        terms: w.terms || '',
        contact: {
            phone: full.mobile || '', alternatePhone: full.alternativeMobileNumber || '', email: full.email || '',
            address: [full.address, full.city, full.state, full.pincode].filter(Boolean).join(', '),
            location: { latitude: w.location?.latitude ?? null, longitude: w.location?.longitude ?? null, mapUrl: w.location?.mapUrl || '' }
        },
        socialLinks: w.socialLinks || {},
        seo: buildSeo(full, w),
        sections: {
            showPlans: w.showPlans !== false, showSeatAvailability: w.showSeatAvailability !== false,
            showStories: w.showStories !== false, showNotices: w.showNotices !== false, showReviews: w.showReviews !== false
        },
        plans,
        seatAvailability: seats,
        stories,
        notices,
        banners,
        offers,
        reviews
    };
};

// ---------------------------------------------------------------------------
// public enquiry
// ---------------------------------------------------------------------------
exports.createPublicEnquiry = async (library, body, ip) => {
    const enquirySvc = require('./enquiry.service');
    const branchId = await resolveBranch(library._id, body.branchId);
    const { enquiry, duplicate } = await enquirySvc.createEnquiry(
        library._id,
        { name: body.name, mobile: body.mobile, email: body.email, address: body.address, message: body.message },
        { source: 'website', ip, branchId }
    );
    if (!duplicate) enquirySvc.notifyOwner(library._id, enquiry);
    return { id: enquiry._id, duplicate };
};

// Public enquiry by library id (body.libraryId): library must be active
exports.findActiveLibraryForEnquiry = async ({ libraryId }) => {
    const lib = await Library.findOne({ _id: libraryId, isDeleted: { $ne: true }, status: 'active' }).select('_id').lean();
    if (!lib) throw new ApiError(404, 'Library not found');
    return lib;
};
