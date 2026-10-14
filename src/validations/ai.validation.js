const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

const queryAi = z.object({
    body: z.object({
        prompt: z.string().trim().min(1, 'Prompt cannot be empty').max(1000, 'Prompt too long'),
        libraryId: objectId.optional() // honoured for superadmin only
    }),
    query: z.object({ libraryId: objectId.optional() }).optional().default({})
});

const historyQuery = z.object({
    query: z.object({
        limit: z.coerce.number().int().min(1).max(50).optional().default(20),
        libraryId: objectId.optional()
    }).optional().default({})
});

const tenantQuery = z.object({
    query: z.object({ libraryId: objectId.optional() }).optional().default({})
});

const confirmAction = z.object({
    body: z.object({
        token: z.string().regex(/^[a-f0-9]{48}$/, 'Invalid confirmation token'),
        libraryId: objectId.optional()
    }),
    query: z.object({ libraryId: objectId.optional() }).optional().default({})
});

module.exports = {
    queryAi,
    historyQuery,
    tenantQuery,
    confirmAction
};
