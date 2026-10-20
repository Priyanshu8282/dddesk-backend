const { z } = require('zod');

const createBranch = z.object({
    body: z.object({
        name: z.string('Branch name is required').trim().min(2, 'Branch name must be at least 2 characters').max(100, 'Branch name is too long'),
        address: z.string().max(300).optional(),
        city: z.string().max(80).optional(),
        state: z.string().max(80).optional(),
        pincode: z.string().regex(/^(\d{6})?$/, 'Pincode must be 6 digits').optional(),
        mobile: z.string().regex(/^([6-9]\d{9})?$/, 'Enter a valid 10-digit mobile number').optional(),
        managerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid manager id').optional().or(z.literal('')),
        notes: z.string().max(500).optional(),
        email: z.string().email('Enter a valid email').optional().or(z.literal('')),
        maxStudents: z.coerce.number().int().min(0).optional().default(0),
        maxSeats: z.coerce.number().int().min(0).optional().default(0),
        openingTime: z.string().optional().default('06:00 AM'),
        closingTime: z.string().optional().default('11:00 PM')
    })
});

// switch a branch on or off
const setBranchStatus = z.object({
    params: z.object({ id: z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id') }),
    body: z.object({
        isActive: z.union([z.boolean(), z.enum(['active', 'inactive'])], 'isActive must be true or false').transform((v) => (typeof v === 'boolean' ? v : v === 'active'))
    })
});

module.exports = {
    setBranchStatus,
    createBranch
};
