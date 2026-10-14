const { z } = require('zod');

const methods = ['cash', 'upi', 'online', 'bank_transfer', 'other'];
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const money = z.coerce.number().positive('Amount must be greater than 0').max(10000000);
const optDate = z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), 'Invalid date');
const idParam = z.object({ paymentId: objectId });

const allocationList = z.array(z.object({
    paymentId: objectId,
    amount: money
})).max(50);

// Create a charge and/or collect money.
const createPayment = z.object({
    body: z.object({
        studentId: objectId,
        planId: objectId.optional(),
        // charge amount (membership part). totalAmount accepted for older clients.
        amount: z.coerce.number().min(0).optional(),
        totalAmount: z.coerce.number().min(0).optional(),
        joiningFee: z.coerce.number().min(0).optional(),
        deposit: z.coerce.number().min(0).optional(),
        couponCode: z.string().trim().min(1).max(40).optional(),
        referrerId: objectId.optional(),
        description: z.string().max(300).optional(),
        dueDate: optDate.optional(),
        // collect now
        paidAmount: z.coerce.number().min(0).optional(),
        paymentMethod: z.enum(methods).default('cash'),
        reference: z.string().max(100).optional(),
        paymentDate: optDate.optional(),
        note: z.string().max(500).optional(),
        remarks: z.string().max(500).optional(),
        allocations: allocationList.optional()
    }).refine((d) => d.planId || d.amount !== undefined || d.totalAmount !== undefined || (d.paidAmount && d.paidAmount > 0),
        { message: 'Provide planId/amount to create a charge, or paidAmount to collect on existing dues', path: ['amount'] })
});

const collectPartialPayment = z.object({
    params: idParam,
    body: z.object({
        additionalAmount: z.coerce.number().positive().optional(),
        amount: z.coerce.number().positive().optional(),
        paymentMethod: z.enum(methods).default('cash'),
        reference: z.string().max(100).optional(),
        paymentDate: optDate.optional(),
        note: z.string().max(500).optional(),
        remarks: z.string().max(500).optional()
    }).refine((d) => d.additionalAmount || d.amount, { message: 'amount must be positive', path: ['amount'] })
});

const refundPayment = z.object({
    params: idParam,
    body: z.object({
        amount: money.optional(),
        reason: z.string().trim().min(3, 'A reason is required').max(300),
        method: z.enum(methods).optional(),
        transactionId: objectId.optional(),
        requestId: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
        refundToGateway: z.boolean().optional()
    })
});

const adjustPayment = z.object({
    params: idParam,
    body: z.object({
        reason: z.string().trim().min(3, 'A reason is required').max(300),
        waiveAmount: money.optional(),
        lateFee: z.coerce.number().min(0).optional(),
        discountAmount: z.coerce.number().min(0).optional(),
        totalAmount: z.coerce.number().positive().optional(),
        dueDate: optDate.optional()
    })
});

const cancelPayment = z.object({
    params: idParam,
    body: z.object({ reason: z.string().trim().min(3, 'A reason is required').max(300) })
});

const queryPayments = z.object({
    query: z.object({
        status: z.string().max(100).optional(),
        method: z.enum(methods).optional(),
        studentId: objectId.optional(),
        from: optDate.optional(),
        to: optDate.optional(),
        search: z.string().max(100).optional(),
        branchId: objectId.optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional()
    })
});

const createRazorpayOrder = z.object({
    body: z.object({
        chargeIds: z.array(objectId).max(50).optional(),
        paymentId: objectId.optional(),
        amount: z.coerce.number().positive().optional(), // optional partial amount, validated against DB dues
        studentId: objectId.optional()                    // staff only
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
        { message: 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required', path: ['razorpayOrderId'] }
    )
});

const idOnly = z.object({ params: idParam });

module.exports = {
    createPayment,
    collectPartialPayment,
    refundPayment,
    adjustPayment,
    cancelPayment,
    queryPayments,
    createRazorpayOrder,
    verifyRazorpayPayment,
    idOnly
};
