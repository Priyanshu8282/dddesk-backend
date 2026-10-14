const { z } = require('zod');

const createPlan = z.object({
    body: z.object({
        name: z.string().min(2, 'Plan name must be at least 2 characters'),
        description: z.string().optional(),
        durationType: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'half-yearly', 'yearly', 'custom']).default('monthly'),
        durationDays: z.coerce.number().optional(),
        price: z.coerce.number().min(0, 'Price must be positive'),
        discount: z.coerce.number().optional().default(0),
        depositAmount: z.coerce.number().optional().default(0),
        joiningFee: z.coerce.number().optional().default(0),
        features: z.array(z.string()).optional().default([]),
        seatTypes: z.array(z.string()).optional().default(['all'])
    })
});

module.exports = {
    createPlan
};
