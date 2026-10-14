const { z } = require('zod');

const scanQR = z.object({
    body: z.object({
        token: z.string().min(1, 'QR token is required')
    })
});

const manualPunch = z.object({
    body: z.object({
        studentId: z.string().min(1, 'Student ID is required'),
        action: z.enum(['check-in', 'check-out']).optional()
    })
});

module.exports = {
    scanQR,
    manualPunch
};
