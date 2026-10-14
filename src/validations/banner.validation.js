const { z } = require('zod');

const createBanner = z.object({
    body: z.object({
        title: z.string().min(2, 'Banner title is required'),
        description: z.string().optional(),
        bannerType: z.enum(['OFFER', 'ACHIEVEMENT', 'SELECTION', 'ANNOUNCEMENT', 'SUCCESS_STORY', 'OTHER']).default('OTHER'),
        redirectUrl: z.string().optional(),
        startDate: z.string().min(1, 'Start date is required'),
        endDate: z.string().min(1, 'End date is required'),
        displayOrder: z.coerce.number().optional().default(1)
    })
});

module.exports = {
    createBanner
};
