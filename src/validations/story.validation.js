const { z } = require('zod');

const createStory = z.object({
    body: z.object({
        title: z.string().min(2, 'Story title is required'),
        description: z.string().optional(),
        type: z.enum(['image', 'video']).default('image')
    })
});

module.exports = {
    createStory
};
