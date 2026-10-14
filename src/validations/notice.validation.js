const { z } = require('zod');

const createNotice = z.object({
    body: z.object({
        title: z.string().min(2, 'Notice title is required'),
        description: z.string().min(1, 'Description is required'),
        type: z.enum(['important', 'general', 'holiday', 'fees']).default('general'),
        sendTo: z.enum(['all', 'premium', 'specific']).default('all'),
        targetStudents: z.union([z.string(), z.array(z.string())]).optional(),
        expiryDate: z.string().optional(),
        libraryId: z.string().optional(),
        isPinned: z.coerce.boolean().optional().default(false)
    })
});

module.exports = {
    createNotice
};
