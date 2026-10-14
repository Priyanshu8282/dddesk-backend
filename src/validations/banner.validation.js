const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');
const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');
const idParam = z.object({ params: z.object({ id: objectId }) });

const bool = z.preprocess((v) => (v === 'true' || v === true ? true : v === 'false' || v === false ? false : v), z.boolean());

// Only http(s) links or app/site relative paths; blocks javascript:, data: etc.
const safeUrl = z.string().trim().max(500).refine(
    (v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v) || /^\/[^\s]*$/.test(v),
    'URL must start with http://, https:// or /'
);

const BANNER_TYPES = ['OFFER', 'ACHIEVEMENT', 'SELECTION', 'ANNOUNCEMENT', 'SUCCESS_STORY', 'OTHER'];
const LOCATIONS = ['website', 'app', 'both'];

const base = {
    title: z.string().trim().min(2, 'Banner title is required').max(150),
    description: z.string().trim().max(500),
    bannerType: z.enum(BANNER_TYPES),
    ctaText: z.string().trim().max(40),
    ctaUrl: safeUrl,
    redirectUrl: safeUrl, // legacy alias of ctaUrl
    displayLocation: z.enum(LOCATIONS),
    startDate: isoDate,
    endDate: isoDate,
    displayOrder: z.coerce.number().int().min(0).max(10000),
    priority: z.coerce.number().int().min(-1000).max(1000),
    isActive: bool,
    branchId: z.preprocess((v) => (v === '' || v === 'null' ? null : v), objectId.nullish()) // null = all branches
};

const dateOrder = (b, ctx) => {
    if (b.startDate && b.endDate && new Date(b.startDate) > new Date(b.endDate)) {
        ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'End date must not be before the start date' });
    }
};

const createBanner = z.object({
    body: z.object({
        ...Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.optional()])),
        title: base.title,
        startDate: z.string().min(1, 'Start date is required').pipe(isoDate),
        endDate: z.string().min(1, 'End date is required').pipe(isoDate),
        bannerType: base.bannerType.default('OTHER'),
        displayLocation: base.displayLocation.default('both')
    }).strip().superRefine(dateOrder)
});

const updateBanner = z.object({
    params: z.object({ id: objectId }),
    body: z.object(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.optional()]))).strip().superRefine(dateOrder)
});

const listBanners = z.object({
    query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        search: z.string().trim().max(100).optional()
    }).passthrough()
});

const activeBanners = z.object({
    query: z.object({ location: z.enum(LOCATIONS).optional() }).passthrough()
});

module.exports = {
    createBanner,
    updateBanner,
    listBanners,
    activeBanners,
    idParam
};
