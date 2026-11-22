const { z } = require('zod');

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const money = z.coerce.number().positive('Amount must be greater than 0').max(10000000);

const idParam = z.object({ id: objectId });

const submitClaim = z.object({
    body: z.object({
        amount: money,
        transactionId: z.string().trim().min(3, 'Enter the UPI transaction id / UTR number').max(100),
        note: z.string().trim().max(300).optional(),
        paymentId: objectId.optional(),
    })
});

const listClaims = z.object({
    query: z.object({
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
    })
});

const approveClaim = z.object({
    params: idParam,
    body: z.object({
        requestId: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
    })
});

const rejectClaim = z.object({
    params: idParam,
    body: z.object({
        reason: z.string().trim().min(3, 'A reason is required').max(300),
    })
});

module.exports = { idParam, submitClaim, listClaims, approveClaim, rejectClaim };
