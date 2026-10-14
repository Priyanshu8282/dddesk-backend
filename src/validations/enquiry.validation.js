const { z } = require('zod');

const createEnquiry = z.object({
    body: z.object({
        name: z.string().min(2, 'Name is required'),
        mobile: z.string().min(10, 'Valid 10-digit mobile number required'),
        email: z.string().email().optional().or(z.literal('')),
        address: z.string().optional(),
        message: z.string().optional(),
        source: z.enum(['website', 'walk-in', 'referral', 'phone', 'other']).default('walk-in'),
        libraryId: z.string().optional(),
        slug: z.string().optional()
    })
});

const updateEnquiry = z.object({
    body: z.object({
        name: z.string().optional(),
        mobile: z.string().optional(),
        email: z.string().optional(),
        status: z.enum(['new', 'contacted', 'interested', 'approved', 'converted', 'rejected', 'closed']).optional(),
        followUpDate: z.string().optional(),
        notes: z.array(z.string()).optional()
    })
});

module.exports = {
    createEnquiry,
    updateEnquiry
};
