const { z } = require('zod');
const { RESERVED_SLUGS, SLUG_RE } = require('../middlewares/tenantHost.middleware');

// http(s) URL only (no javascript:, data:, etc.). Empty string clears the field.
const httpUrl = z.string().trim().max(500).refine((v) => {
    if (v === '') return true;
    try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) { return false; }
}, { message: 'Must be a valid http(s) URL' });

// Image: http(s) URL or an uploaded file path
const imageRef = z.string().trim().max(500).refine(
    (v) => v === '' || v.startsWith('/uploads/') || /^https?:\/\/[^\s]+$/i.test(v),
    { message: 'Must be an http(s) URL or an uploaded file path' }
);

const hexColor = z.string().trim().refine((v) => v === '' || /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v), { message: 'Must be a hex color like #1a2b3c' });
const shortText = (n) => z.string().trim().max(n);
const timeText = z.string().trim().max(20);

const updateSettings = z.object({
    body: z.object({
        about: shortText(5000).optional(),
        announcement: shortText(500).optional(),
        facilities: z.array(shortText(80).min(1)).max(50).optional(),
        gallery: z.array(z.object({
            url: imageRef.refine((v) => v !== '', { message: 'Image url required' }),
            caption: shortText(200).optional().default(''),
            order: z.coerce.number().int().min(0).max(1000).optional().default(0)
        })).max(30).optional(),
        openingHours: z.object({
            openingTime: timeText.optional(),
            closingTime: timeText.optional(),
            openDays: shortText(60).optional(),
            weeklyHoliday: shortText(60).optional()
        }).optional(),
        weeklyHolidays: z.array(z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])).max(7).optional(),
        rules: shortText(5000).optional(),
        terms: shortText(10000).optional(),
        socialLinks: z.object({
            facebook: httpUrl.optional(),
            instagram: httpUrl.optional(),
            twitter: httpUrl.optional(),
            youtube: httpUrl.optional(),
            website: httpUrl.optional()
        }).optional(),
        theme: z.object({
            primaryColor: hexColor.optional(),
            secondaryColor: hexColor.optional(),
            accentColor: hexColor.optional(),
            fontFamily: shortText(60).regex(/^[A-Za-z0-9 ,'-]*$/, 'Invalid font name').optional(),
            heroImage: imageRef.optional(),
            logo: imageRef.optional(),
            layout: z.enum(['default', 'modern', 'classic', 'minimal']).optional()
        }).optional(),
        location: z.object({
            latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
            longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
            mapUrl: httpUrl.optional()
        }).optional(),
        seo: z.object({
            title: shortText(70).optional(),
            description: shortText(200).optional(),
            ogImage: imageRef.optional()
        }).optional(),
        showSeatAvailability: z.boolean().optional(),
        showStories: z.boolean().optional(),
        showNotices: z.boolean().optional(),
        showPlans: z.boolean().optional(),
        showReviews: z.boolean().optional(),
        isPublished: z.boolean().optional()
    })
});

const domainRe = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

const customDomain = z.object({
    body: z.object({
        domain: z.string().trim().toLowerCase()
            .transform((v) => v.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, ''))
            .refine((v) => domainRe.test(v), { message: 'Enter a valid domain such as library.example.com' })
    })
});

const changeSlug = z.object({
    body: z.object({
        slug: z.string().trim().toLowerCase()
            .refine((v) => SLUG_RE.test(v), { message: 'Slug must be 3-40 characters: lowercase letters, numbers and hyphens, not starting or ending with a hyphen' })
            .refine((v) => !v.includes('--'), { message: 'Slug cannot contain consecutive hyphens' })
            .refine((v) => !RESERVED_SLUGS.includes(v), { message: 'This slug is reserved' })
    })
});

const slugParam = z.object({
    params: z.object({ slug: z.string().trim().toLowerCase().min(2).max(60) })
});

const publicEnquiry = z.object({
    params: z.object({ slug: z.string().trim().toLowerCase().min(2).max(60) }),
    body: z.object({
        name: z.string().trim().min(2, 'Name is required').max(100),
        mobile: z.string().trim().transform((v) => v.replace(/[\s()-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
            .refine((v) => /^[6-9]\d{9}$/.test(v), { message: 'Valid 10-digit mobile number required' }),
        email: z.string().trim().email().max(120).optional().or(z.literal('')),
        address: z.string().trim().max(300).optional(),
        message: z.string().trim().max(1000).optional(),
        branchId: z.string().regex(/^[a-f0-9]{24}$/i).optional(), // optional branch the enquiry is for
        // honeypot: real users leave this empty
        website: z.string().max(200).optional(),
        hp: z.string().max(200).optional()
    })
});

const legacyPublicEnquiry = z.object({
    body: publicEnquiry.shape.body.extend({
        slug: z.string().trim().toLowerCase().max(60).optional(),
        libraryId: z.string().regex(/^[a-f\d]{24}$/i).optional()
    }).refine((b) => b.slug || b.libraryId, { message: 'slug or libraryId is required' })
});

const resolveQuery = z.object({
    query: z.object({ host: z.string().trim().max(255).optional(), slug: z.string().trim().max(60).optional() }).optional()
});

module.exports = { updateSettings, customDomain, changeSlug, slugParam, publicEnquiry, legacyPublicEnquiry, resolveQuery };
