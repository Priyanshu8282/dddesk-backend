const { z } = require('zod');

const createPayment = z.object({
    body: z.object({
        studentId: z.string().min(1, 'Student ID is required'),
        planId: z.string().optional(),
        totalAmount: z.coerce.number().min(0, 'Total amount must be positive'),
        paidAmount: z.coerce.number().min(0).default(0),
        discountAmount: z.coerce.number().optional().default(0),
        lateFee: z.coerce.number().optional().default(0),
        paymentMethod: z.enum(['cash', 'upi', 'online', 'bank_transfer', 'other']).default('cash'),
        dueDate: z.string().optional(),
        paymentDate: z.string().optional(),
        remarks: z.string().optional()
    })
});

const collectPartialPayment = z.object({
    body: z.object({
        additionalAmount: z.coerce.number().min(1).optional(),
        amount: z.coerce.number().min(1).optional(),
        paymentMethod: z.enum(['cash', 'upi', 'online', 'bank_transfer', 'other']).default('cash'),
        remarks: z.string().optional()
    }).refine((data) => (data.additionalAmount && data.additionalAmount > 0) || (data.amount && data.amount > 0), {
        message: 'additionalAmount must be positive',
        path: ['additionalAmount']
    })
});

const createRazorpayOrder = z.object({
    body: z.object({
        planId: z.string().optional(),
        amount: z.coerce.number().optional(),
        paymentType: z.string().optional(),
        studentId: z.string().optional()
    }).refine((data) => data.planId || data.amount, {
        message: 'planId or amount is required',
        path: ['planId']
    })
});

const verifyRazorpayPayment = z.object({
    body: z.object({
        razorpayOrderId: z.string().optional(),
        razorpayPaymentId: z.string().optional(),
        razorpaySignature: z.string().optional(),
        razorpay_order_id: z.string().optional(),
        razorpay_payment_id: z.string().optional(),
        razorpay_signature: z.string().optional()
    }).refine(
        (data) => (data.razorpayOrderId || data.razorpay_order_id) &&
                  (data.razorpayPaymentId || data.razorpay_payment_id) &&
                  (data.razorpaySignature || data.razorpay_signature),
        {
            message: 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required',
            path: ['razorpayOrderId']
        }
    )
});

module.exports = {
    createPayment,
    collectPartialPayment,
    createRazorpayOrder,
    verifyRazorpayPayment
};
