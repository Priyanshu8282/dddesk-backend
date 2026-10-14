const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');
const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');
const idParam = z.object({ params: z.object({ id: objectId }) });

const complaintCategories = [
    'ac', 'fan', 'light', 'wifi', 'chair', 'table', 'charging', 'washroom', 'cleanliness', 'noise', 'water', 'other'
];
const complaintPriorities = ['low', 'medium', 'high', 'urgent'];
const complaintStatuses = ['open', 'assigned', 'in_progress', 'resolved', 'closed'];

// `images` / `videos` are only ever populated from uploaded files, never from the body.
const createComplaint = z.object({
    body: z.object({
        title: z.string().trim().min(2, 'Title must be at least 2 characters').max(150),
        description: z.string().trim().min(3, 'Description must be at least 3 characters').max(2000),
        category: z.enum(complaintCategories).optional().default('other'),
        priority: z.enum(complaintPriorities).optional().default('medium'),
        seatNumber: z.string().trim().max(30).optional(),
        room: z.string().trim().max(60).optional(),
        seatId: objectId.optional(),
        studentId: objectId.optional(),
        branchId: objectId.optional(),
        assignedTo: objectId.optional()
    }).strip()
});

const updateComplaint = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        title: z.string().trim().min(2).max(150).optional(),
        description: z.string().trim().min(3).max(2000).optional(),
        category: z.enum(complaintCategories).optional(),
        priority: z.enum(complaintPriorities).optional(),
        seatNumber: z.string().trim().max(30).optional(),
        room: z.string().trim().max(60).optional(),
        resolutionNote: z.string().trim().max(1000).optional(),
        cost: z.coerce.number().min(0).max(10000000).optional()
    }).strip()
});

const updateStatus = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        status: z.enum(complaintStatuses, { error: 'Status must be one of: open, assigned, in_progress, resolved, closed' }),
        resolutionNote: z.string().trim().max(1000).optional(),
        cost: z.coerce.number().min(0).max(10000000).optional()
    }).strip()
});

const assignComplaint = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        assignedTo: objectId,
        notes: z.string().trim().max(500).optional()
    }).strip()
});

const addNote = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        message: z.string().trim().min(1, 'Note message is required').max(1000),
        isInternal: z.preprocess((v) => v === true || v === 'true', z.boolean()).optional()
    }).strip()
});

const getComplaintsQuery = z.object({
    query: z.object({
        status: z.enum(complaintStatuses).optional(),
        category: z.enum(complaintCategories).optional(),
        priority: z.enum(complaintPriorities).optional(),
        search: z.string().trim().max(100).optional(),
        assignedTo: objectId.optional(),
        studentId: objectId.optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        page: z.coerce.number().int().min(1).optional().default(1),
        limit: z.coerce.number().int().min(1).max(100).optional().default(20)
    }).passthrough().optional()
});

const maintenanceHistoryQuery = z.object({
    query: z.object({
        seatId: objectId.optional(),
        seatNumber: z.string().trim().max(30).optional(),
        room: z.string().trim().max(60).optional(),
        category: z.enum(complaintCategories).optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional()
    }).passthrough()
});

const recurringQuery = z.object({
    query: z.object({
        days: z.coerce.number().int().min(1).max(365).optional(),
        min: z.coerce.number().int().min(2).max(50).optional()
    }).passthrough()
});

module.exports = {
    createComplaint,
    updateComplaint,
    updateStatus,
    assignComplaint,
    addNote,
    getComplaintsQuery,
    maintenanceHistoryQuery,
    recurringQuery,
    idParam
};
