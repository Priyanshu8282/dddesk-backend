const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');
const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');
const idParam = z.object({ params: z.object({ id: objectId }) });

// multipart/form-data sends 'true' / 'false' strings. z.coerce.boolean() turns 'false' into true, so parse explicitly.
const bool = z.preprocess((v) => {
    if (v === 'true' || v === true || v === '1') return true;
    if (v === 'false' || v === false || v === '0') return false;
    return v;
}, z.boolean());

// Accepts an array, a JSON array string or a comma separated string
const idList = z.preprocess((v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        try {
            const parsed = JSON.parse(v);
            if (Array.isArray(parsed)) return parsed;
        } catch (_) { /* fall through */ }
        return v.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return v;
}, z.array(objectId).max(2000));

const TYPES = ['holiday', 'timing-change', 'fee-reminder', 'exam', 'maintenance', 'emergency', 'important', 'general'];
const AUDIENCES = ['all', 'selected', 'branch', 'membershipGroup'];
// legacy clients: 'specific' means selected students
const audience = z.preprocess((v) => (v === 'specific' ? 'selected' : v), z.enum(AUDIENCES));

const fields = {
    title: z.string().trim().min(2, 'Notice title is required').max(150),
    description: z.string().trim().min(1, 'Description is required').max(3000),
    type: z.enum(TYPES),
    sendTo: audience,
    targetStudents: idList,
    targetBranchIds: idList,
    targetPlanIds: idList,
    startDate: isoDate,
    endDate: isoDate.nullable(),
    expiryDate: isoDate, // legacy alias of endDate
    isPinned: bool,
    showOnWebsite: bool,
    isActive: bool,
    branchId: z.preprocess((v) => (v === '' || v === 'null' ? null : v), objectId.nullish()) // null = all branches
};

const createNotice = z.object({
    body: z.object({
        ...fields,
        type: fields.type.default('general'),
        sendTo: fields.sendTo.default('all'),
        startDate: fields.startDate.optional(),
        endDate: fields.endDate.optional(),
        expiryDate: fields.expiryDate.optional(),
        targetStudents: fields.targetStudents.optional(),
        targetBranchIds: fields.targetBranchIds.optional(),
        targetPlanIds: fields.targetPlanIds.optional(),
        isPinned: fields.isPinned.optional(),
        showOnWebsite: fields.showOnWebsite.optional(),
        isActive: fields.isActive.optional(),
        branchId: fields.branchId.optional()
    }).strip()
});

const updateNotice = z.object({
    params: z.object({ id: objectId }),
    body: z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()]))).strip()
});

const listNotices = z.object({
    query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        search: z.string().trim().max(100).optional(),
        status: z.enum(['all', 'active', 'inactive', 'scheduled', 'expired']).optional(),
        type: z.enum(TYPES).optional(),
        branchId: objectId.optional()
    }).passthrough()
});

module.exports = {
    createNotice,
    updateNotice,
    listNotices,
    idParam
};
