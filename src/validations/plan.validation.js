const { z } = require('zod');

const DURATION_TYPES = ['daily', 'weekly', 'monthly', 'quarterly', 'half-yearly', 'yearly', 'custom'];
const SEAT_TYPES = ['standard', 'premium', 'window', 'ac', 'non-ac', 'custom', 'all'];
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm (24h)');

const planFields = {
    name: z.string().trim().min(2, 'Plan name must be at least 2 characters'),
    description: z.string().optional(),
    durationType: z.enum(DURATION_TYPES),
    durationDays: z.coerce.number().int().min(1, 'durationDays must be at least 1').max(3650).optional(),
    price: z.coerce.number().min(0, 'Price must be positive'),
    discount: z.coerce.number().min(0),
    depositAmount: z.coerce.number().min(0),
    joiningFee: z.coerce.number().min(0),
    features: z.array(z.string()),
    seatTypes: z.array(z.enum(SEAT_TYPES)),
    shiftName: z.string().trim().max(60),
    shiftStart: hhmm,
    shiftEnd: hhmm,
    allowRenewal: z.boolean(),
    autoRenewReminderDays: z.coerce.number().int().min(0).max(60)
};

const customNeedsDays = (d) => d.durationType !== 'custom' || (d.durationDays && d.durationDays > 0);
const customMsg = { message: 'durationDays is required for custom plans', path: ['durationDays'] };
const discountOk = (d) => d.discount === undefined || d.price === undefined || d.discount <= d.price;
const discountMsg = { message: 'Discount cannot exceed price', path: ['discount'] };
const shiftOk = (d) => (d.shiftStart === undefined) === (d.shiftEnd === undefined);
const shiftMsg = { message: 'shiftStart and shiftEnd must be provided together', path: ['shiftEnd'] };

const createPlan = z.object({
    body: z.object({
        ...planFields,
        durationType: planFields.durationType.default('monthly'),
        discount: planFields.discount.optional().default(0),
        depositAmount: planFields.depositAmount.optional().default(0),
        joiningFee: planFields.joiningFee.optional().default(0),
        features: planFields.features.optional().default([]),
        seatTypes: planFields.seatTypes.optional().default(['all']),
        shiftName: planFields.shiftName.optional(),
        shiftStart: hhmm.optional(),
        shiftEnd: hhmm.optional(),
        allowRenewal: z.boolean().optional().default(true),
        autoRenewReminderDays: planFields.autoRenewReminderDays.optional().default(3),
        status: z.boolean().optional()
    }).refine(customNeedsDays, customMsg).refine(discountOk, discountMsg).refine(shiftOk, shiftMsg)
});

const updatePlan = z.object({
    body: z.object({
        name: planFields.name.optional(),
        description: planFields.description,
        durationType: planFields.durationType.optional(),
        durationDays: planFields.durationDays,
        price: planFields.price.optional(),
        discount: planFields.discount.optional(),
        depositAmount: planFields.depositAmount.optional(),
        joiningFee: planFields.joiningFee.optional(),
        features: planFields.features.optional(),
        seatTypes: planFields.seatTypes.optional(),
        shiftName: planFields.shiftName.optional(),
        shiftStart: hhmm.or(z.literal('')).optional(),
        shiftEnd: hhmm.or(z.literal('')).optional(),
        allowRenewal: z.boolean().optional(),
        autoRenewReminderDays: planFields.autoRenewReminderDays.optional(),
        status: z.boolean().optional()
    }).refine(customNeedsDays, customMsg).refine(discountOk, discountMsg)
});

const updatePlanStatus = z.object({
    body: z.object({
        status: z.union([z.boolean(), z.enum(['active', 'inactive'])]).transform((v) => (typeof v === 'boolean' ? v : v === 'active'))
    })
});

const listPlans = z.object({
    query: z.object({
        search: z.string().optional(),
        status: z.string().optional(),
        duration: z.string().optional(),
        sort: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional()
    }).passthrough()
});

module.exports = {
    createPlan,
    updatePlan,
    updatePlanStatus,
    listPlans
};
