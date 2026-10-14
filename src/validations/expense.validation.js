const { z } = require('zod');

const createExpense = z.object({
    body: z.object({
        title: z.string().min(2, 'Expense title/reason is required'),
        amount: z.coerce.number().min(1, 'Amount must be greater than 0'),
        category: z.string().optional().default('General'),
        paymentMethod: z.enum(['cash', 'upi', 'bank_transfer', 'other']).default('cash'),
        date: z.string().optional(),
        description: z.string().optional()
    })
});

module.exports = {
    createExpense
};
