const { z } = require('zod');
const { GSTIN_RE } = require('../utils/feeMath');
const { normalizeMobile } = require('../utils/mobile');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const emptyToUndef = (s) => z.preprocess((v) => (v === '' || v === null ? undefined : v), s);
const mobile = z.string().trim().transform(normalizeMobile).refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit Indian mobile number');
const timeStr = z.string().trim().max(20);

// human-check fields travel with the body; the middleware strips them before validation of the rest
const humanFields = {
    humanToken: z.string().max(4000).optional(),
    hp_website: z.string().max(200).optional(),
    fillMs: z.coerce.number().optional(),
};

// A draft can be saved half-filled, so every field is optional and EMPTY STRING is allowed (clears it). Unknown keys => 400.
const draftData = z.strictObject({
    name: z.string().trim().max(120),
    ownerName: z.string().trim().max(100),
    email: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(120)]),
    address: z.string().trim().max(300),
    city: z.string().trim().max(80),
    state: z.string().trim().max(80),
    district: z.string().trim().max(80),
    pincode: z.union([z.literal(''), z.string().trim().regex(/^[1-9]\d{5}$/, 'Pincode must be 6 digits')]),
    country: z.string().trim().max(60),
    seatCapacity: z.union([z.null(), z.coerce.number().int().min(1).max(100000)]),
    workingHours: z.strictObject({
        openingTime: timeStr, closingTime: timeStr,
        weeklyHoliday: z.string().trim().max(60), openDays: z.string().trim().max(60),
    }).partial(),
    facilities: z.array(z.string().trim().min(1).max(60)).max(50),
    alternativeMobileNumber: z.union([z.literal(''), mobile]),
    website: z.string().trim().max(200),
    gstNumber: z.union([z.literal(''), z.string().trim().transform((v) => v.toUpperCase()).refine((v) => GSTIN_RE.test(v), 'Enter a valid 15-character GSTIN')]),
    description: z.string().trim().max(1000),
}).partial();

const patchDraft = z.object({
    body: z.strictObject({
        step: z.coerce.number().int().min(1).max(4).optional(),
        planId: z.union([z.null(), objectId]).optional(),
        billingCycle: z.enum(['monthly', 'annual']).optional(),
        data: draftData.optional(),
        consent: z.strictObject({ terms: z.boolean(), privacy: z.boolean(), marketing: z.boolean() }).partial().optional(),
        // allowed so a client can send the token in the body instead of the header
        registrationToken: z.string().max(2000).optional(),
    }),
});

const completeBody = z.object({
    body: z.strictObject({
        completeKey: z.string().trim().regex(/^[A-Za-z0-9_-]{16,64}$/, 'completeKey must be 16-64 URL-safe characters'),
        password: emptyToUndef(z.string().min(8, 'Password must be at least 8 characters').max(128).optional()),
        otpOnly: z.boolean().optional(),
        consent: z.strictObject({ terms: z.boolean(), privacy: z.boolean(), marketing: z.boolean().optional() }),
        registrationToken: z.string().max(2000).optional(),
        ...humanFields,
    }).refine((b) => b.otpOnly === true || !!b.password, { message: 'Set a password or choose OTP-only sign-in', path: ['password'] }),
});

// Final completeness check of the stored draft (required for creating the library)
const completeData = z.object({
    name: z.string().trim().min(2).max(120),
    ownerName: z.string().trim().min(2).max(100),
    email: emptyToUndef(z.string().trim().toLowerCase().email().optional()),
    address: z.string().trim().min(3).max(300),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().min(2).max(80),
    pincode: z.string().trim().regex(/^[1-9]\d{5}$/),
    seatCapacity: z.coerce.number().int().min(1).max(100000),
    workingHours: z.object({ openingTime: timeStr.min(1), closingTime: timeStr.min(1) }),
});

const humanStatus = z.object({ query: z.object({ identifier: z.string().trim().max(120).optional() }) });

const tourPatch = z.object({
    body: z.strictObject({
        lastStep: z.coerce.number().int().min(0).max(50).optional(),
        completed: z.boolean().optional(),
        skipped: z.boolean().optional(),
        restart: z.boolean().optional(),
    }),
});

module.exports = { patchDraft, completeBody, completeData, humanStatus, tourPatch, humanFields, draftData };
