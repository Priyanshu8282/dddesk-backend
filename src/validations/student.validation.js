const { z } = require('zod');

const createStudent = z.object({
    body: z.object({
        name: z.string().min(2, 'Name must be at least 2 characters'),
        mobile: z.string().min(10, 'Valid 10-digit mobile number required'),
        email: z.string().email('Invalid email address').optional().or(z.literal('')),
        password: z.string().min(4).optional().default('123456'),
        rollNumber: z.string().optional(),
        seatNumber: z.string().optional(),
        seatId: z.string().optional(),
        planId: z.string().optional(),
        joiningDate: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        pincode: z.string().optional(),
        guardianName: z.string().optional(),
        guardianMobile: z.string().optional(),
        gender: z.enum(['Male', 'Female', 'Other']).optional(),
        aadhaarNumber: z.string().optional()
    })
});

const assignPlan = z.object({
    body: z.object({
        planId: z.string().min(1, 'Plan ID is required'),
        joiningDate: z.string().optional()
    })
});

const markAsPaid = z.object({
    body: z.object({
        paymentMethod: z.enum(['cash', 'online', 'upi', 'bank_transfer', 'other']).default('cash'),
        remarks: z.string().optional()
    })
});

module.exports = {
    createStudent,
    assignPlan,
    markAsPaid
};
