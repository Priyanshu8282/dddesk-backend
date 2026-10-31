const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');
const isoDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');
const emptyQuery = z.object({}).passthrough();

const scanQR = z.object({
    body: z.object({
        token: z.string().min(1, 'QR token is required').max(2000)
    })
});

const selfCheck = z.object({
    body: z.object({
        token: z.string().min(1).max(2000).optional(),
        action: z.enum(['in', 'out']).optional()
    })
});

const manualPunch = z.object({
    body: z.object({
        studentId: objectId,
        type: z.enum(['in', 'out']).optional(),
        action: z.enum(['check-in', 'check-out']).optional(),
        time: isoDate.optional()
    })
});

const manualMark = z.object({
    body: z.object({
        studentId: objectId,
        type: z.enum(['in', 'out']),
        time: isoDate.optional()
    })
});

const manualClose = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        reason: z.string().trim().max(300).optional(),
        checkOutTime: isoDate.optional()
    }).default({})
});

const correct = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        reason: z.string().trim().min(3, 'Reason is required').max(500),
        status: z.enum(['present', 'absent', 'leave']).optional(),
        checkIn: isoDate.nullable().optional(),
        checkOut: isoDate.nullable().optional(),
        leaveReason: z.string().trim().max(300).optional()
    }).refine((b) => b.status !== undefined || b.checkIn !== undefined || b.checkOut !== undefined, {
        message: 'Nothing to correct'
    })
});

const leave = z.object({
    body: z.object({
        studentId: objectId,
        date: isoDate,
        reason: z.string().trim().min(2, 'Reason is required').max(300)
    })
});

const listQuery = z.object({
    query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        date: isoDate.optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        studentId: objectId.optional(),
        status: z.enum(['present', 'absent', 'leave']).optional(),
        search: z.string().trim().max(100).optional(),
        sort: z.string().optional()
    }).passthrough()
});

const rangeFields = z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM').optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    sort: z.enum(['name', 'low', 'high']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
}).passthrough();

// Whole-library report: no id in the path (the validator passes an empty params object)
const rangeQuery = z.object({ query: rangeFields });

// Per-student report: /student/:id/summary
const studentRangeQuery = z.object({ params: z.object({ id: objectId }), query: rangeFields });

const myQuery = z.object({
    query: z.object({
        date: isoDate.optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional()
    }).passthrough()
});

module.exports = { scanQR, selfCheck, manualPunch, manualMark, manualClose, correct, leave, listQuery, rangeQuery, studentRangeQuery, myQuery, emptyQuery };
