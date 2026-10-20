const { z } = require('zod');

const optDate = z.string('Date must be text').refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');
const objectId = z.string('Invalid id').regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const METHODS = ['cash', 'upi', 'bank_transfer', 'other'];
const SORTS = ['newest', 'oldest', 'amount_high', 'amount_low', 'title'];

// Rupees with at most 2 decimals
const twoDecimals = (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const amount = z.coerce.number('Amount must be a number')
    .positive('Amount must be greater than 0')
    .max(100000000, 'Amount is too large')
    .refine(twoDecimals, 'Amount can have at most 2 decimal places');

const createExpense = z.object({
    body: z.object({
        title: z.string('Title is required').trim().min(2, 'Expense title/reason is required').max(200),
        amount,
        category: z.string().trim().max(60).optional().default('other'),
        customCategory: z.string().trim().max(40).optional(),
        paymentMethod: z.enum(METHODS).default('cash'),
        date: optDate.optional(),
        vendor: z.string().trim().max(120).optional(),
        notes: z.string().max(1000).optional(),
        description: z.string().max(1000).optional(),
        receiptImage: z.string().max(500).optional(),
        branchId: objectId.nullish()
    })
});

const updateExpense = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        title: z.string().trim().min(2, 'Expense title/reason is required').max(200).optional(),
        amount: amount.optional(),
        category: z.string().trim().max(60).optional(),
        customCategory: z.string().trim().max(40).optional(),
        paymentMethod: z.enum(METHODS).optional(),
        date: optDate.optional(),
        vendor: z.string().trim().max(120).optional(),
        notes: z.string().max(1000).optional(),
        description: z.string().max(1000).optional(),
        receiptImage: z.string().max(500).optional(),
        branchId: objectId.nullish()
    })
});

const listQuery = {
    category: z.string().max(60).optional(),
    paymentMethod: z.enum(METHODS).optional(),
    from: optDate.optional(),
    to: optDate.optional(),
    minAmount: z.coerce.number().min(0).optional(),
    maxAmount: z.coerce.number().min(0).optional(),
    search: z.string().max(100).optional(),
    sort: z.enum(SORTS).optional(),
    branchId: objectId.optional()
};

const queryExpenses = z.object({
    query: z.object({
        ...listQuery,
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        export: z.enum(['true', 'false']).optional(),
        format: z.enum(['json', 'csv']).optional()
    })
});

const exportExpenses = z.object({ query: z.object(listQuery) });
const summaryQuery = z.object({ query: z.object({ branchId: objectId.optional() }) });

const idParam = z.object({ params: z.object({ id: objectId }) });

module.exports = {
    createExpense,
    updateExpense,
    queryExpenses,
    exportExpenses,
    summaryQuery,
    idParam
};
