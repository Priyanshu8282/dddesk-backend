const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');
const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');
const STATUSES = ['new', 'contacted', 'interested', 'approved', 'converted', 'rejected', 'closed'];
const SOURCES = ['website', 'walk-in', 'referral', 'phone', 'other'];

const lower = (schema) => z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), schema);

// Indian mobile: strip spaces/dashes/+91 and require 10 digits
const mobile = z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    let d = v.replace(/[\s\-()]/g, '');
    if (d.startsWith('+')) d = d.slice(1);
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    return d;
}, z.string().regex(/^[6-9]\d{9}$/, 'Valid 10-digit mobile number required'));

// Used by the public website form AND the staff "add enquiry" form.
// `hp` is a honeypot: real users never fill it.
const createEnquiry = z.object({
    body: z.object({
        name: z.string().trim().min(2, 'Name is required').max(100),
        mobile,
        email: z.string().trim().email().max(150).optional().or(z.literal('')),
        address: z.string().trim().max(300).optional(),
        message: z.string().trim().max(1000).optional(),
        source: lower(z.enum(SOURCES)).optional(),
        sourceDetail: z.string().trim().max(200).optional(),
        followUpDate: isoDate.optional(),
        libraryId: objectId.optional(),
        slug: z.string().trim().min(1).max(120).optional(),
        branchId: objectId.nullish(),
        hp: z.string().max(200).optional()
    }).strip()
});

const updateEnquiry = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        name: z.string().trim().min(2).max(100).optional(),
        mobile: mobile.optional(),
        email: z.string().trim().email().max(150).optional().or(z.literal('')),
        address: z.string().trim().max(300).optional(),
        message: z.string().trim().max(1000).optional(),
        sourceDetail: z.string().trim().max(200).optional(),
        status: lower(z.enum(STATUSES)).optional(),
        followUpDate: isoDate.nullable().optional(),
        notes: z.array(z.string().trim().min(1).max(1000)).max(50).optional(),
        note: z.string().trim().min(1).max(1000).optional(),
        assignedTo: objectId.nullable().optional()
    }).strip()
});

const idParam = z.object({ params: z.object({ id: objectId }) });

const listEnquiries = z.object({
    query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        status: lower(z.enum(STATUSES)).optional(),
        source: lower(z.enum(SOURCES)).optional(),
        search: z.string().trim().max(100).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        followUpDue: z.preprocess((v) => v === 'true' || v === true, z.boolean()).optional(),
        assignedTo: objectId.optional()
    }).passthrough()
});

const convertEnquiry = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        planId: objectId.optional(),
        seatId: objectId.optional(),
        joiningDate: isoDate.optional(),
        name: z.string().trim().min(2).max(100).optional(),
        mobile: mobile.optional(),
        email: z.string().trim().email().max(150).optional().or(z.literal('')),
        // first sign-in password for a NEW student (ignored when the mobile already belongs to a student)
        password: z.string().min(8, 'Password must be at least 8 characters').max(64).regex(/[A-Za-z]/, 'Password must contain a letter').regex(/d/, 'Password must contain a number').optional(),
        confirmPassword: z.string().optional()
    }).strip().default({}).superRefine((b, ctx) => {
        if (b.password !== undefined && b.confirmPassword !== b.password) ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Passwords do not match' });
    })
});

const conversionStats = z.object({
    query: z.object({ from: isoDate.optional(), to: isoDate.optional() }).passthrough()
});

const addNote = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        text: z.string().trim().min(1, 'Note text is required').max(1000)
    }).strip()
});

module.exports = {
    createEnquiry,
    updateEnquiry,
    idParam,
    listEnquiries,
    convertEnquiry,
    conversionStats,
    addNote
};
