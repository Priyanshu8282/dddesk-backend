const { z } = require('zod');

const optDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

const createExpense = z.object({
    body: z.object({
        title: z.string().trim().min(2, 'Expense title/reason is required').max(200),
        amount: z.coerce.number().positive('Amount must be greater than 0').max(100000000),
        category: z.string().trim().max(60).optional().default('other'),
        paymentMethod: z.enum(['cash', 'upi', 'bank_transfer', 'other']).default('cash'),
        date: optDate.optional(),
        notes: z.string().max(1000).optional(),
        description: z.string().max(1000).optional(),
        receiptImage: z.string().max(500).optional(),
        branchId: objectId.nullish()
    })
});

const updateExpense = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        title: z.string().trim().min(2).max(200).optional(),
        amount: z.coerce.number().positive().max(100000000).optional(),
        category: z.string().trim().max(60).optional(),
        paymentMethod: z.enum(['cash', 'upi', 'bank_transfer', 'other']).optional(),
        date: optDate.optional(),
        notes: z.string().max(1000).optional(),
        description: z.string().max(1000).optional(),
        receiptImage: z.string().max(500).optional(),
        branchId: objectId.nullish()
    })
});

const queryExpenses = z.object({
    query: z.object({
        category: z.string().max(60).optional(),
        paymentMethod: z.enum(['cash', 'upi', 'bank_transfer', 'other']).optional(),
        from: optDate.optional(),
        to: optDate.optional(),
        search: z.string().max(100).optional(),
        branchId: objectId.optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        export: z.enum(['true', 'false']).optional(),
        format: z.enum(['json', 'csv']).optional()
    })
});

const idParam = z.object({ params: z.object({ id: objectId }) });

module.exports = {
    createExpense,
    updateExpense,
    queryExpenses,
    idParam
};
