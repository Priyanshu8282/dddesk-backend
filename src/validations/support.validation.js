const { z } = require('zod');

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const CATEGORIES = ['general', 'billing', 'technical', 'feature_request', 'account', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

const paging = {
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional()
};

const createTicket = z.object({
    body: z.object({
        subject: z.string().trim().min(3).max(200),
        message: z.string().trim().min(5).max(5000),
        category: z.enum(CATEGORIES).optional().default('general'),
        priority: z.enum(PRIORITIES).optional().default('medium')
    })
});

const listOwn = z.object({
    query: z.object({ status: z.enum(STATUSES).optional(), ...paging }).passthrough()
});

const idParam = z.object({ params: z.object({ id: objectId }) });

const reply = z.object({
    params: z.object({ id: objectId }),
    body: z.object({ message: z.string().trim().min(1).max(5000) })
});

const listAll = z.object({
    query: z.object({
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        category: z.enum(CATEGORIES).optional(),
        libraryId: objectId.optional(),
        assignedTo: objectId.optional(),
        search: z.string().trim().max(100).optional(),
        ...paging
    }).passthrough()
});

const update = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        assignedTo: objectId.nullable().optional()
    }).strict().refine((b) => b.status !== undefined || b.priority !== undefined || b.assignedTo !== undefined,
        { message: 'Provide status, priority or assignedTo' })
});

module.exports = { createTicket, listOwn, idParam, reply, listAll, update, CATEGORIES, PRIORITIES, STATUSES };
