const { z } = require('zod');
const { normalizeMobile } = require('../utils/mobile');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const mobile = z.string().trim().transform(normalizeMobile).refine((v) => /^\+?\d{10,13}$/.test(v), 'Enter a valid mobile number');
const emptyToUndef = (s) => z.preprocess((v) => (v === '' || v === 'null' ? undefined : v), s);

// branchIds may arrive as an array, JSON array string, comma list or single id (multipart)
const idList = z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        const t = v.trim();
        if (t.startsWith('[')) { try { return JSON.parse(t); } catch (_) { return v; } }
        return t.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return v;
}, z.array(objectId).max(100));

const idParam = z.object({ params: z.object({ id: objectId }) });

const commonFields = {
    name: z.string().trim().min(2, 'Name is required').max(100),
    mobile,
    alternativeMobileNumber: emptyToUndef(mobile.optional()),
    address: z.string().trim().max(300).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().max(80).optional(),
    country: z.string().trim().max(60).optional(),
    pincode: z.string().trim().max(10).optional(),
    joiningDate: emptyToUndef(z.coerce.date().optional()),
    documentNames: z.string().max(5000).optional(),
};

const createStaff = z.object({
    body: z.object({
        ...commonFields,
        email: z.string().trim().toLowerCase().email('Valid email is required'),
        password: z.string().min(8, 'Password must be at least 8 characters').max(128),
        roleId: emptyToUndef(objectId.optional()),
        branchIds: idList.optional(),
        libraryId: emptyToUndef(objectId.optional()), // superadmin only (ignored for tenants)
    })
});

const updateStaff = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        ...commonFields,
        email: z.string().trim().toLowerCase().email().optional(),
        roleId: emptyToUndef(objectId.optional()),
        branchIds: idList.optional(),
        status: z.preprocess((v) => (v === 'true' || v === 'active' ? true : v === 'false' || v === 'inactive' ? false : v), z.boolean().optional()),
        // owner self-edit may carry these; they are routed to the library by the service
        ownerName: z.string().trim().max(100).optional(),
        website: z.string().trim().max(200).optional(),
        gstNumber: z.string().trim().max(20).optional(),
        existingPhotos: z.string().max(10000).optional(),
        profileImage: z.string().max(500).optional(),
    }).partial()
});

const updateStatus = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        status: z.preprocess(
            (v) => (v === 'true' || v === 'active' ? true : v === 'false' || v === 'inactive' ? false : v),
            z.boolean({ error: "status must be 'active' or 'inactive'" })
        ),
    })
});

const resetStaffPassword = z.object({
    params: z.object({ id: objectId }),
    body: z.object({ newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128) })
});

module.exports = { createStaff, updateStaff, updateStatus, resetStaffPassword, idParam, objectId };
