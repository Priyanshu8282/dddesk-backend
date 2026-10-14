const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const otp = z.string().trim().regex(/^\d{6}$/, 'OTP must be 6 digits');
const newPassword = z.string().min(8, 'Password must be at least 8 characters').max(128);

// Optional tenant hint: the same student mobile can exist in several libraries
const tenantHint = {
    libraryId: objectId.optional(),
    slug: z.string().trim().toLowerCase().max(63).optional(),
};

const login = z.object({
    body: z.object({
        identifier: z.string().trim().optional(),
        email: z.string().trim().email().optional().or(z.literal('')),
        mobile: z.string().trim().optional(),
        password: z.string().min(1, 'Password is required'),
        userRole: z.string().optional(),
        fcmToken: z.string().max(500).optional(),
        ...tenantHint
    }).refine((data) => data.identifier || data.email || data.mobile, {
        message: 'Either email, mobile, or identifier is required',
        path: ['identifier']
    })
});

const sendOTP = z.object({
    body: z.object({
        mobile: z.string().trim().min(10, 'Valid 10-digit mobile number required').max(15),
        userRole: z.string().optional(),
        ...tenantHint
    })
});

const verifyOTP = z.object({
    body: z.object({
        mobile: z.string().trim().min(10).max(15),
        otp,
        userRole: z.string().optional(),
        fcmToken: z.string().max(500).optional(),
        ...tenantHint
    })
});

const forgotPassword = z.object({
    body: z.object({
        email: z.string().trim().email('Valid email required').optional(),
        mobile: z.string().trim().min(10).max(15).optional(),
        ...tenantHint
    }).refine((data) => data.email || data.mobile, {
        message: 'Either email or mobile is required'
    })
});

const verifyResetOTP = z.object({
    body: z.object({
        email: z.string().trim().email().optional(),
        mobile: z.string().trim().min(10).max(15).optional(),
        otp,
        ...tenantHint
    }).refine((data) => data.email || data.mobile, {
        message: 'Either email or mobile is required'
    })
});

const resetPassword = z.object({
    body: z.object({
        email: z.string().trim().email().optional(),
        mobile: z.string().trim().min(10).max(15).optional(),
        otp,
        newPassword,
        ...tenantHint
    }).refine((data) => data.email || data.mobile, {
        message: 'Either email or mobile is required'
    })
});

const updateProfile = z.object({
    body: z.object({
        name: z.string().trim().min(2).max(100).optional(),
        currentPassword: z.string().optional(),
        newPassword: newPassword.optional(),
    }).refine((d) => !d.newPassword || !!d.currentPassword, {
        message: 'Current password is required to set a new password',
        path: ['currentPassword']
    })
});

const changePassword = z.object({
    body: z.object({
        currentPassword: z.string().min(1, 'Current password is required'),
        newPassword,
    })
});

const fcmToken = z.object({
    body: z.object({ fcmToken: z.string().trim().min(10, 'FCM Token is required').max(500) })
});

module.exports = {
    login,
    sendOTP,
    verifyOTP,
    forgotPassword,
    verifyResetOTP,
    resetPassword,
    updateProfile,
    changePassword,
    fcmToken
};
