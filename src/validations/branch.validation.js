const { z } = require('zod');

const createBranch = z.object({
    body: z.object({
        name: z.string().min(2, 'Branch name is required'),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        pincode: z.string().optional(),
        mobile: z.string().optional(),
        email: z.string().email().optional().or(z.literal('')),
        maxStudents: z.coerce.number().optional().default(0),
        maxSeats: z.coerce.number().optional().default(0),
        openingTime: z.string().optional().default('06:00 AM'),
        closingTime: z.string().optional().default('11:00 PM')
    })
});

module.exports = {
    createBranch
};
