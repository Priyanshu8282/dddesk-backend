const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');
const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');
const idParam = z.object({ params: z.object({ id: objectId }) });

// multipart fields arrive as strings
const bool = z.preprocess((v) => (v === 'true' || v === true ? true : v === 'false' || v === false ? false : v), z.boolean());

const createStory = z.object({
    body: z.object({
        title: z.string().trim().min(2, 'Story title is required').max(100),
        description: z.string().trim().max(500).optional(),
        textContent: z.string().trim().max(500).optional(),
        type: z.enum(['image', 'video', 'text', 'offer']).optional(),
        publishAt: isoDate.optional(),
        expiresInHours: z.coerce.number().int().min(1).max(168).optional(),
        branchId: z.preprocess((v) => (v === '' || v === 'null' ? null : v), objectId.nullish()).optional()
    }).strip()
});

const updateStory = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        title: z.string().trim().min(2).max(100).optional(),
        description: z.string().trim().max(500).optional(),
        textContent: z.string().trim().max(500).optional(),
        publishAt: isoDate.optional(),
        expiresInHours: z.coerce.number().int().min(1).max(168).optional(),
        isActive: bool.optional(),
        branchId: z.preprocess((v) => (v === '' || v === 'null' ? null : v), objectId.nullish()).optional()
    }).strip()
});

const listStories = z.object({
    query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        search: z.string().trim().max(100).optional(),
        status: z.enum(['all', 'scheduled', 'active', 'inactive', 'expired', 'archived']).optional(),
        type: z.enum(['image', 'video', 'text', 'offer']).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        sort: z.enum(['newest', 'oldest', 'views', 'expiring', 'title']).optional()
    }).passthrough()
});

const reply = z.object({
    params: z.object({ id: objectId }),
    body: z.object({ message: z.string().trim().min(1, 'Message is required').max(300) }).strip()
});

module.exports = {
    createStory,
    updateStory,
    listStories,
    reply,
    idParam
};
