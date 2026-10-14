const express = require('express');
const { z } = require('zod');
const c = require('../../controllers/subscription.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireOwner, requireSuperAdmin } = require('../../middlewares/access.middleware');

const sv = require('../../validations/subscription.validation');
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');

const verifySchema = z.object({
    body: z.object({
        razorpayOrderId: z.string().optional(),
        razorpayPaymentId: z.string().optional(),
        razorpaySignature: z.string().optional(),
        razorpay_order_id: z.string().optional(),
        razorpay_payment_id: z.string().optional(),
        razorpay_signature: z.string().optional()
    }).refine((d) => (d.razorpayOrderId || d.razorpay_order_id) && (d.razorpayPaymentId || d.razorpay_payment_id) && (d.razorpaySignature || d.razorpay_signature),
        { message: 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required', path: ['razorpayOrderId'] })
});
const libParam = z.object({ params: z.object({ libraryId: objectId }) });

// Library owner: mounted at /libraries/subscription
const owner = express.Router();
owner.get('/', requireOwner, c.getSubscription);
owner.post('/change-plan', requireOwner, validate(sv.changePlan), c.changePlan);
owner.post('/cancel', requireOwner, validate(sv.cancel), c.cancel);
owner.post('/resume', requireOwner, c.resume);
owner.get('/payments', requireOwner, c.myPayments);
owner.post('/order', requireOwner, validate(sv.order), c.createOrder);
owner.post('/verify', requireOwner, validate(verifySchema), c.verify);

// Super admin: mounted at /super/subscriptions
const superAdmin = express.Router();
superAdmin.get('/', requireSuperAdmin, c.listAll);
superAdmin.get('/:libraryId/payments', requireSuperAdmin, validate(libParam), c.libraryPayments);

module.exports = { owner, superAdmin };
