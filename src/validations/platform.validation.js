const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const idParam = z.object({ params: z.object({ id: objectId }) });

// ---------- roles ----------
const idArray = z.array(objectId).max(500);
const createRole = z.object({
    body: z.object({
        name: z.string().trim().min(2, 'Role name is required').max(60),
        description: z.string().trim().max(300).optional(),
        permissionIds: idArray.optional(),
        sidebarMenuIds: idArray.optional(),
        status: z.boolean().optional(),
        libraryId: objectId.optional(), // honoured for superadmin only
    })
});
const updateRole = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        name: z.string().trim().min(2).max(60).optional(),
        description: z.string().trim().max(300).optional(),
        permissionIds: idArray.optional(),
        sidebarMenuIds: idArray.optional(),
        status: z.boolean().optional(),
    })
});

// ---------- permissions ----------
const permissionBody = {
    name: z.string().trim().min(2).max(100),
    key: z.string().trim().min(2).max(80).regex(/^[A-Za-z0-9_.:-]+$/, 'Key may only contain letters, digits and _ . : -'),
    module: z.string().trim().min(2).max(60),
    route: z.string().trim().max(100).optional(),
    description: z.string().trim().max(300).optional(),
    scope: z.enum(['tenant', 'platform']).optional(),
};
const createPermission = z.object({ body: z.object(permissionBody) });
const updatePermission = z.object({ params: z.object({ id: objectId }), body: z.object(permissionBody).partial() });

// ---------- sidebar ----------
const prio = z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().trim().regex(/^-?\d+(\.\d+)?$/, 'Priority must be numeric'));
const sidebarBody = {
    title: z.string().trim().min(1).max(100),
    iconStyle: z.string().max(300).optional(),
    to: z.string().max(200).optional(),
    parent_module_id: z.string().max(50).optional(),
    module_menu_priority: prio.optional(),
    module_id: z.string().max(50).optional(),
    module_priority: prio.optional(),
    classChange: z.string().max(100).optional(),
    classsChange: z.string().max(100).optional(),
    extraClass: z.string().max(100).optional(),
    extraclass: z.string().max(100).optional(),
    hasMenu: z.boolean().optional(),
    userType: z.enum(['admin', 'library', 'staff', 'superadmin', 'student']).optional(),
    content: z.array(z.object({ title: z.string().min(1).max(100), to: z.string().max(200).optional(), update: z.string().max(200).optional() })).max(50).optional(),
};
const createMenu = z.object({ body: z.object(sidebarBody) });
const updateMenu = z.object({ params: z.object({ id: objectId }), body: z.object(sidebarBody).partial() });

// ---------- settings ----------
const settingKey = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/, 'Invalid key');
const upsertSetting = z.object({
    params: z.object({ key: settingKey.optional() }).optional(),
    body: z.object({
        key: settingKey.optional(),
        value: z.any().refine((v) => v !== undefined, 'value is required'),
        description: z.string().max(300).optional(),
        isPublic: z.boolean().optional(),
    })
});

// ---------- platform plans ----------
const planFields = {
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(500),
    monthlyPrice: z.coerce.number().min(0),
    annualPrice: z.coerce.number().min(0),
    gstPercent: z.coerce.number().min(0).max(28),
    isPopular: z.boolean(),
    sortOrder: z.coerce.number().int().min(0).max(9999),
    trialDays: z.coerce.number().int().min(0).max(365),
    graceDays: z.coerce.number().int().min(0).max(90),
    maxStudents: z.coerce.number().int().min(0),
    maxSeats: z.coerce.number().int().min(0),
    maxStaff: z.coerce.number().int().min(0),
    maxBranches: z.coerce.number().int().min(0),
    features: z.array(z.string().trim().min(1).max(100)).max(100),
    isActive: z.boolean(),
};
const createPlatformPlan = z.object({
    body: z.object(planFields).partial().required({ name: true, monthlyPrice: true })
});
const updatePlatformPlan = z.object({ params: z.object({ id: objectId }), body: z.object(planFields).partial() });

// ---------- super library ----------
const rejectOrSuspend = z.object({
    params: z.object({ id: objectId }),
    body: z.object({ reason: z.string().trim().min(3, 'A reason is required').max(500) })
});
const assignPlan = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        planId: objectId,
        subscriptionExpiry: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.date().optional()),
        isTrial: z.boolean().optional(),
    })
});
const changeSlug = z.object({
    params: z.object({ id: objectId }),
    body: z.object({ slug: z.string().trim().toLowerCase().min(3).max(63) })
});
const superCreateLibrary = z.object({
    body: z.object({
        name: z.string().trim().min(2).max(120),
        ownerName: z.string().trim().min(2).max(100),
        email: z.string().trim().toLowerCase().email(),
        mobile: z.string().trim().min(10).max(15),
        password: z.string().min(8).max(128),
        confirmPassword: z.string().max(128).optional(),
        address: z.string().trim().max(300).optional(),
        city: z.string().trim().max(80).optional(),
        state: z.string().trim().max(80).optional(),
        country: z.string().trim().max(60).optional(),
        pincode: z.string().trim().max(12).optional(),
        alternativeMobileNumber: z.string().trim().max(15).optional(),
        seatCapacity: z.coerce.number().int().min(0).optional(),
    }).superRefine((b, ctx) => {
        if (b.confirmPassword !== undefined && b.confirmPassword !== b.password) {
            ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Passwords do not match' });
        }
        const { findState, findCountry, isIndia } = require('../data/indiaLocations');
        if (b.country && !findCountry(b.country)) {
            ctx.addIssue({ code: 'custom', path: ['country'], message: 'Country not supported yet' });
        }
        if (b.pincode && isIndia(b.country) && !/^\d{6}$/.test(b.pincode)) {
            ctx.addIssue({ code: 'custom', path: ['pincode'], message: 'Pincode must be 6 digits' });
        }
        if (b.state && isIndia(b.country) && !findState(b.state)) {
            ctx.addIssue({ code: 'custom', path: ['state'], message: 'Choose a state from the list' });
        }
    }).transform(({ confirmPassword, ...rest }) => {
        const { findState, isIndia } = require('../data/indiaLocations');
        return { ...rest, ...(rest.state && isIndia(rest.country) ? { state: findState(rest.state) } : {}) };
    })
});
const superUpdateLibrary = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        name: z.string().trim().min(2).max(120),
        ownerName: z.string().trim().min(2).max(100),
        email: z.string().trim().toLowerCase().email(),
        mobile: z.string().trim().min(10).max(15),
        alternativeMobileNumber: z.string().trim().max(15),
        address: z.string().trim().max(300),
        city: z.string().trim().max(80),
        state: z.string().trim().max(80),
        country: z.string().trim().max(60),
        pincode: z.string().trim().max(10),
        website: z.string().trim().max(200),
        gstNumber: z.string().trim().max(20),
        removeOwnerImage: z.enum(['true', 'false']),
    }).partial()
});

// ---------- branches ----------
const updateBranch = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        name: z.string().trim().min(2).max(100),
        address: z.string().trim().max(300),
        city: z.string().trim().max(80),
        state: z.string().trim().max(80),
        pincode: z.string().trim().max(10),
        mobile: z.string().trim().max(15),
        email: z.string().trim().email().or(z.literal('')),
        managerId: objectId.or(z.literal('')).or(z.null()),
        isActive: z.boolean(),
        openingTime: z.string().trim().max(20),
        closingTime: z.string().trim().max(20),
        maxStudents: z.coerce.number().int().min(0),
        maxSeats: z.coerce.number().int().min(0),
        notes: z.string().max(500),
    }).partial()
});

module.exports = {
    objectId, idParam,
    createRole, updateRole, createPermission, updatePermission, createMenu, updateMenu, upsertSetting,
    createPlatformPlan, updatePlatformPlan, rejectOrSuspend, assignPlan, changeSlug,
    superCreateLibrary, superUpdateLibrary, updateBranch,
};
