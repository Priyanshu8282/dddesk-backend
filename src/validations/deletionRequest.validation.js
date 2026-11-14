const { z } = require('zod');

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

const paging = {
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional()
};

const requestDeletion = z.object({
    body: z.object({ reason: z.string().trim().max(2000).optional() })
});

const idParam = z.object({ params: z.object({ id: objectId }) });

const list = z.object({
    query: z.object({ status: z.enum(STATUSES).optional(), ...paging }).passthrough()
});

const reject = z.object({
    params: z.object({ id: objectId }),
    body: z.object({ note: z.string().trim().max(2000).optional() })
});

const review = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        status: z.enum(['approved', 'rejected']),
        note: z.string().trim().max(2000).optional()
    })
});

module.exports = { requestDeletion, idParam, list, reject, review, STATUSES };
