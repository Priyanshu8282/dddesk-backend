const { z } = require('zod');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ID');
const idParam = z.object({ params: z.object({ id: objectId }) });

// z.coerce.boolean() would turn the string 'false' into true; parse explicitly
const bool = z.preprocess((v) => {
    if (v === 'true' || v === true || v === '1') return true;
    if (v === 'false' || v === false || v === '0') return false;
    return v;
}, z.boolean());

const aspectSchema = z.object({
    cleanliness: z.coerce.number().min(1).max(5).optional(),
    wifi: z.coerce.number().min(1).max(5).optional(),
    comfort: z.coerce.number().min(1).max(5).optional(),
    ambience: z.coerce.number().min(1).max(5).optional(),
    staff: z.coerce.number().min(1).max(5).optional()
}).strip().optional();

const submitReview = z.object({
    body: z.object({
        rating: z.coerce.number().int('Rating must be a whole number').min(1, 'Rating must be at least 1 star').max(5, 'Rating cannot exceed 5 stars'),
        review: z.string().trim().min(10, 'Review must be at least 10 characters').max(1000, 'Review cannot exceed 1000 characters'),
        type: z.enum(['public', 'internal']).optional().default('public'),
        isAnonymous: bool.optional().default(false),
        aspects: aspectSchema
    }).strip()
});

const updateStatus = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        status: z.enum(['pending', 'approved', 'rejected'], { error: 'Status must be pending, approved, or rejected' }).optional(),
        isFeatured: bool.optional()
    }).strip().refine((b) => b.status !== undefined || b.isFeatured !== undefined, { message: 'Nothing to update' })
});

const replyReview = z.object({
    params: z.object({ id: objectId }),
    body: z.object({
        reply: z.string().trim().min(1, 'Reply cannot be empty').max(1000, 'Reply cannot exceed 1000 characters')
    }).strip()
});

const queryReviews = z.object({
    query: z.object({
        status: z.enum(['all', 'pending', 'approved', 'rejected']).optional().default('all'),
        type: z.enum(['public', 'internal']).optional(),
        rating: z.coerce.number().int().min(1).max(5).optional(),
        isFeatured: bool.optional(),
        page: z.coerce.number().int().min(1).optional().default(1),
        limit: z.coerce.number().int().min(1).max(100).optional().default(20)
    }).passthrough().optional()
});

module.exports = {
    submitReview,
    updateStatus,
    replyReview,
    queryReviews,
    idParam
};
