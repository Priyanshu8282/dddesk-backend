const { z } = require('zod');

const login = z.object({
    body: z.object({
        identifier: z.string().optional(),
        email: z.string().email().optional().or(z.literal('')),
        mobile: z.string().optional(),
        password: z.string().min(1, 'Password is required').optional(),
        otp: z.string().length(6).optional(),
        userRole: z.string().optional(),
        fcmToken: z.string().optional()
    }).refine((data) => data.identifier || data.email || data.mobile, {
        message: 'Either email, mobile, or identifier is required',
        path: ['identifier']
    })
});

const sendOTP = z.object({
    body: z.object({
        mobile: z.string().min(10, 'Valid 10-digit mobile number required').max(15),
        userRole: z.string().optional()
    })
});

const verifyOTP = z.object({
    body: z.object({
        mobile: z.string().min(10).max(15),
        otp: z.string().length(6, 'OTP must be 6 digits'),
        userRole: z.string().optional(),
        fcmToken: z.string().optional()
    })
});

const forgotPassword = z.object({
    body: z.object({
        email: z.string().email('Valid email required').optional(),
        mobile: z.string().min(10).optional()
    }).refine((data) => data.email || data.mobile, {
        message: 'Either email or mobile is required'
    })
});

const resetPassword = z.object({
    body: z.object({
        email: z.string().email().optional(),
        mobile: z.string().optional(),
        otp: z.string().length(6, 'OTP must be 6 digits'),
        newPassword: z.string().min(6, 'Password must be at least 6 characters')
    })
});

module.exports = {
    login,
    sendOTP,
    verifyOTP,
    forgotPassword,
    resetPassword
};
