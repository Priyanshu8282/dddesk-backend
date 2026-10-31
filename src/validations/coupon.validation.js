const { z } = require('zod');

const offerTypes = ['general', 'new_student', 'referral', 'festival', 'first_month', 'limited_seat'];
const discountTypes = ['flat', 'percentage'];

const createCoupon = z.object({
    body: z.object({
        title: z.string().min(2, 'Title must be at least 2 characters'),
        code: z.string().min(2, 'Coupon code must be at least 2 characters').toUpperCase(),
        description: z.string().optional(),
        discountType: z.enum(discountTypes, {
            message: 'Discount type must be flat or percentage'
        }),
        discountValue: z.coerce.number().min(1, 'Discount value must be greater than 0'),
        maxDiscountAmount: z.coerce.number().optional().nullable(),
        minOrderAmount: z.coerce.number().optional().default(0),
        applicablePlans: z.union([z.array(z.string()), z.string()]).optional(),
        offerType: z.enum(offerTypes).optional().default('general'),
        startDate: z.string().optional(),
        endDate: z.string().min(1, 'End date / expiry is required'),
        usageLimit: z.coerce.number().optional().nullable(),
        perStudentLimit: z.coerce.number().optional().default(1),
        isActive: z.coerce.boolean().optional().default(true)
    })
});

const updateCoupon = z.object({
    params: z.object({
        id: z.string().min(1, 'Coupon ID is required')
    }),
    body: z.object({
        title: z.string().optional(),
        code: z.string().optional().transform(v => v ? v.toUpperCase() : undefined),
        description: z.string().optional(),
        discountType: z.enum(discountTypes).optional(),
        discountValue: z.coerce.number().optional(),
        maxDiscountAmount: z.coerce.number().optional().nullable(),
        minOrderAmount: z.coerce.number().optional(),
        applicablePlans: z.union([z.array(z.string()), z.string()]).optional(),
        offerType: z.enum(offerTypes).optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        usageLimit: z.coerce.number().optional().nullable(),
        perStudentLimit: z.coerce.number().optional(),
        isActive: z.coerce.boolean().optional()
    })
});

const validateCoupon = z.object({
    body: z.object({
        code: z.string().min(1, 'Coupon code is required').toUpperCase(),
        amount: z.coerce.number().min(1, 'Amount must be greater than 0'),
        planId: z.string().optional(),
        studentId: z.string().optional(),
        referrerId: z.string().optional()
    })
});

const queryCoupons = z.object({
    query: z.object({
        status: z.enum(['all', 'active', 'inactive', 'expired', 'upcoming']).optional().default('all'),
        offerType: z.string().optional(),
        discountType: z.enum(discountTypes).optional(),
        search: z.string().optional(),
        page: z.coerce.number().optional().default(1),
        limit: z.coerce.number().max(100).optional().default(20)
    }).optional()
});

module.exports = {
    createCoupon,
    updateCoupon,
    validateCoupon,
    queryCoupons
};
