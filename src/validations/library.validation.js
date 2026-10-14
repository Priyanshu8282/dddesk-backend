const { z } = require('zod');
const { normalizeMobile } = require('../utils/mobile');

// ---- helpers (multipart/form-data sends everything as strings) ----
const json = (schema) => z.preprocess((v) => {
    if (typeof v === 'string') {
        const t = v.trim();
        if (t === '') return undefined;
        try { return JSON.parse(t); } catch (_) { return v; }
    }
    return v;
}, schema);

const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const num = z.coerce.number();
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const mobile = z.string().trim().transform(normalizeMobile).refine((v) => /^\+?\d{10,13}$/.test(v), 'Enter a valid mobile number');

// facilities: JSON array, array, or comma-separated string
const stringList = z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        const t = v.trim();
        if (t.startsWith('[')) { try { return JSON.parse(t); } catch (_) { /* fall through */ } }
        return t.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return v;
}, z.array(z.string().trim().min(1).max(60)).max(50));

const timeStr = z.string().trim().min(1, 'Required').max(20);
const emptyToUndef = (s) => z.preprocess((v) => (v === '' ? undefined : v), s);

// ---- Public self registration (spec section 6) ----
const register = z.object({
    body: z.preprocess((b) => {
        // accept flat openingTime/closingTime as well as workingHours JSON/object
        if (!b || typeof b !== 'object') return b;
        const out = { ...b };
        if (typeof out.workingHours === 'string') {
            try { out.workingHours = JSON.parse(out.workingHours); } catch (_) { /* validated below */ }
        }
        if ((!out.workingHours || typeof out.workingHours !== 'object') && (out.openingTime || out.closingTime)) {
            out.workingHours = { openingTime: out.openingTime, closingTime: out.closingTime };
        }
        return out;
    }, z.object({
        registrationToken: emptyToUndef(z.string().trim().max(2000).optional()),
        name: z.string().trim().min(2, 'Library name is required').max(120),
        ownerName: z.string().trim().min(2, 'Owner name is required').max(100),
        mobile,
        email: z.string().trim().toLowerCase().email('Valid email is required'),
        password: z.string().min(8, 'Password must be at least 8 characters').max(128),
        address: z.string().trim().min(3, 'Address is required').max(300),
        city: z.string().trim().min(2, 'City is required').max(80),
        state: z.string().trim().min(2, 'State is required').max(80),
        pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
        country: emptyToUndef(z.string().trim().max(60).optional()),
        seatCapacity: num.int('Seat capacity must be a whole number').min(1, 'Seat capacity is required').max(100000),
        workingHours: z.object({
            openingTime: timeStr,
            closingTime: timeStr,
            weeklyHoliday: z.string().trim().max(60).optional(),
            openDays: z.string().trim().max(60).optional(),
        }, { error: 'Operating hours are required' }),
        facilities: stringList.optional(),
        alternativeMobileNumber: emptyToUndef(mobile.optional()),
        website: emptyToUndef(z.string().trim().max(200).optional()),
        gstNumber: emptyToUndef(z.string().trim().max(20).optional()),
        description: emptyToUndef(z.string().trim().max(1000).optional()),
    }))
});

// ---- Library profile & settings (spec section 7); every field optional, unknown keys dropped ----
const url = z.string().trim().max(300);
const profileBody = z.object({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(2000),
    alternativeMobileNumber: z.union([z.literal(''), mobile]), // '' clears it
    email: z.string().trim().toLowerCase().email(),
    address: z.string().trim().max(300),
    city: z.string().trim().max(80),
    state: z.string().trim().max(80),
    country: z.string().trim().max(60),
    pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
    website: url,
    gstNumber: z.string().trim().max(20),
    facilities: stringList,
    seatCapacity: num.int().min(0).max(100000),
    mapLocation: json(z.object({
        lat: num.min(-90).max(90).optional(),
        lng: num.min(-180).max(180).optional(),
        url: url.optional(),
    })),
    socialLinks: json(z.object({
        facebook: url.optional(), instagram: url.optional(), twitter: url.optional(),
        youtube: url.optional(), linkedin: url.optional(), whatsapp: url.optional(),
    })),
    workingHours: json(z.object({
        openingTime: timeStr.optional(), closingTime: timeStr.optional(),
        weeklyHoliday: z.string().trim().max(60).optional(), openDays: z.string().trim().max(60).optional(),
    })),
    weeklyHolidays: stringList,
    rules: z.string().max(10000),
    terms: z.string().max(20000),
    timezone: z.string().trim().min(3).max(60).refine((tz) => {
        try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
    }, 'Invalid timezone'),
    currency: z.string().trim().length(3).transform((s) => s.toUpperCase()),
    feePolicy: json(z.object({
        allowCredit: bool.optional(),
        maxCreditAmount: num.min(0).optional(),
        maxCreditDays: num.int().min(0).optional(),
        graceDays: num.int().min(0).optional(),
        reminderFrequencyDays: num.int().min(0).optional(),
        blockAfterDue: bool.optional(),
    })),
    attendanceRules: json(z.object({
        graceMinutes: num.int().min(0).optional(),
        lateAfterMinutes: num.int().min(0).optional(),
        autoReleaseNoShow: bool.optional(),
        noShowGraceMinutes: num.int().min(0).optional(),
        enforceShift: bool.optional(),
    })),
    notificationPrefs: json(z.object({
        email: bool.optional(), sms: bool.optional(), push: bool.optional(), whatsapp: bool.optional(),
        feeReminders: bool.optional(), expiryReminders: bool.optional(),
        newEnquiry: bool.optional(), newComplaint: bool.optional(),
        attendanceAlerts: bool.optional(),
    })),
    receipt: json(z.object({
        prefix: z.string().trim().min(1).max(10).optional(),
        nextNumber: num.int().min(1).optional(),
        footerNote: z.string().trim().max(300).optional(),
    })),
    brand: json(z.object({
        primaryColor: z.string().trim().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
        secondaryColor: z.string().trim().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
        theme: z.enum(['light', 'dark', 'auto']).optional(),
    })),
    settings: json(z.object({
        allowStudentRegistration: bool.optional(),
        attendanceEnabled: bool.optional(),
    })),
    // image handling flags / helpers (files themselves come through multer)
    logo: z.string().max(500),
    coverImage: z.string().max(500),
    existingPhotos: z.string().max(10000),
}).partial();

const updateProfile = z.object({
    body: profileBody.superRefine((v, ctx) => {
        if (v.receipt?.nextNumber !== undefined && !Number.isInteger(v.receipt.nextNumber)) {
            ctx.addIssue({ code: 'custom', message: 'nextNumber must be an integer', path: ['receipt', 'nextNumber'] });
        }
    })
});

const changePassword = z.object({
    body: z.object({
        currentPassword: z.string().min(1, 'Current password is required'),
        newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128),
    })
});

const auditQuery = z.object({
    query: z.object({
        action: z.string().trim().max(80).optional(),
        resource: z.string().trim().max(80).optional(),
        userId: objectId.optional(),
        libraryId: objectId.optional(),
        from: z.string().trim().max(40).optional(),
        to: z.string().trim().max(40).optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
    })
});

const regSendOtp = z.object({ body: z.object({ mobile }) });
const regVerifyOtp = z.object({ body: z.object({ mobile, otp: z.string().trim().regex(/^d{6}$/, 'OTP must be 6 digits') }) });

module.exports = { regSendOtp, regVerifyOtp, register, updateProfile, changePassword, auditQuery, objectId, json, bool, num, mobile, stringList };
