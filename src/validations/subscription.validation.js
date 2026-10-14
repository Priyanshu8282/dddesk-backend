const { z } = require('zod');

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const cycle = z.enum(['monthly', 'annual']);

const changePlan = z.object({
    body: z.object({
        platformPlanId: objectId,
        billingCycle: cycle,
        preview: z.boolean().optional().default(false)
    })
});

const cancel = z.object({
    body: z.object({ reason: z.string().trim().min(3, 'A reason is required').max(500) })
});

const order = z.object({
    body: z.object({
        platformPlanId: objectId.optional(),
        period: cycle.optional(),
        billingCycle: cycle.optional()
    }).transform((b) => ({ platformPlanId: b.platformPlanId, period: b.period || b.billingCycle }))
});

module.exports = { changePlan, cancel, order };
