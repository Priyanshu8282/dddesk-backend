const { z } = require('zod');

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const mobile = z.string().trim().regex(/^\+?\d{10,15}$/, 'Valid mobile number required (10-15 digits)');
const emptyToUndef = (v) => (v === '' || v === null ? undefined : v);

// Multipart bodies deliver nested objects as JSON strings
const jsonObject = (schema) => z.preprocess((v) => {
    if (typeof v === 'string') {
        try { return JSON.parse(v); } catch (e) { return v; }
    }
    return v;
}, schema);

const emergencyContact = jsonObject(z.object({
    name: z.string().trim().max(100).optional(),
    mobile: z.string().trim().max(20).optional(),
    relation: z.string().trim().max(50).optional()
}));

const studentFields = {
    name: z.string().trim().min(2, 'Name must be at least 2 characters'),
    email: z.preprocess(emptyToUndef, z.string().email('Invalid email address').optional()),
    mobile,
    rollNumber: z.string().optional(),
    dob: z.preprocess(emptyToUndef, z.coerce.date().optional()),
    gender: z.preprocess(emptyToUndef, z.enum(['Male', 'Female', 'Other']).optional()),
    aadhaarNumber: z.string().optional(),
    guardianName: z.string().optional(),
    guardianMobile: z.string().optional(),
    guardianOccupation: z.string().optional(),
    emergencyContact: emergencyContact.optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    countryCode: z.string().optional(),
    stateCode: z.string().optional(),
    pincode: z.string().optional(),
    branchId: z.preprocess(emptyToUndef, objectId.optional()),
    joiningDate: z.preprocess(emptyToUndef, z.coerce.date().optional())
};

const createStudent = z.object({
    body: z.object({
        ...studentFields,
        // Required: the owner sets the student's first password (the student is asked to change it at first sign-in)
        password: z.string('Password is required')
            .min(8, 'Password must be at least 8 characters')
            .max(64, 'Password must be 64 characters or fewer')
            .regex(/[A-Za-z]/, 'Password must contain a letter')
            .regex(/\d/, 'Password must contain a number'),
        confirmPassword: z.string().optional(),
        seatId: z.preprocess(emptyToUndef, objectId.optional()),
        planId: z.preprocess(emptyToUndef, objectId.optional()),
        documentType: z.string().optional(),
        dueDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        couponCode: z.preprocess(emptyToUndef, z.string().trim().min(1).max(40).optional()),
        referrerId: z.preprocess(emptyToUndef, objectId.optional())
    }).superRefine((b, ctx) => {
        if (b.confirmPassword !== undefined && b.confirmPassword !== b.password) {
            ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Passwords do not match' });
        }
    })
});

const updateStudent = z.object({
    body: z.object({
        ...studentFields,
        name: studentFields.name.optional(),
        mobile: mobile.optional(),
        documentType: z.string().optional()
    })
});

const assignPlan = z.object({
    body: z.object({
        planId: objectId,
        joiningDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        dueDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        couponCode: z.preprocess(emptyToUndef, z.string().trim().min(1).max(40).optional()),
        referrerId: z.preprocess(emptyToUndef, objectId.optional())
    })
});

const markAsPaid = z.object({
    body: z.object({
        paymentMethod: z.enum(['cash', 'online', 'upi', 'card', 'bank_transfer', 'cheque', 'other']).default('cash'),
        // 0 = activate the membership on credit (pay later, subject to the library credit policy)
        amount: z.coerce.number().min(0).optional(),
        transactionId: z.string().optional(),
        startDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        remarks: z.string().max(500).optional()
    })
});

const changePlan = z.object({
    body: z.object({
        planId: objectId,
        startDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        reason: z.string().max(300).optional()
    })
});

const renew = z.object({
    body: z.object({
        planId: z.preprocess(emptyToUndef, objectId.optional()),
        startDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        keepSeat: z.boolean().optional().default(true),
        dueDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        couponCode: z.preprocess(emptyToUndef, z.string().trim().min(1).max(40).optional()),
        referrerId: z.preprocess(emptyToUndef, objectId.optional())
    })
});

// Student portal: self-service profile edit (only these fields; never plan/status/library)
const updateMyProfile = z.object({
    body: z.object({
        name: z.string().trim().min(2).max(100).optional(),
        email: z.string().trim().toLowerCase().email().optional(),
        address: z.string().trim().max(300).optional(),
        emergencyContact: z.object({
            name: z.string().trim().max(100).optional(),
            mobile: z.string().trim().max(20).optional(),
            relation: z.string().trim().max(50).optional()
        }).optional()
    }).strict()
});

// Student portal: ask the library to renew (staff completes it and collects the fee)
const renewRequest = z.object({
    body: z.object({
        planId: z.preprocess(emptyToUndef, objectId.optional()),
        note: z.string().trim().max(300).optional()
    })
});

const pauseMembership = z.object({
    body: z.object({
        reason: z.string().trim().min(3, 'A reason is required').max(300)
    })
});

const resumeMembership = z.object({
    body: z.object({
        reason: z.string().trim().max(300).optional()
    })
});

const extendMembership = z.object({
    body: z.object({
        days: z.coerce.number().int().min(1).max(365),
        reason: z.string().trim().min(3, 'A reason is required').max(300)
    })
});

const setStatus = z.object({
    body: z.object({
        status: z.enum(['active', 'inactive', 'leave', 'suspended']),
        reason: z.string().trim().max(300).optional(),
        leaveUntil: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        releaseSeat: z.boolean().optional()
    }).refine((d) => d.status === 'active' || (d.reason && d.reason.length >= 3), {
        message: 'A reason is required when changing status away from active',
        path: ['reason']
    })
});

const addNote = z.object({
    body: z.object({
        text: z.string().trim().min(1, 'Note text is required').max(2000)
    })
});

const listStudents = z.object({
    query: z.object({
        search: z.string().max(100).optional(),
        status: z.string().optional(),
        membershipStatus: z.string().optional(),
        branchId: z.string().optional(),
        planId: z.string().optional(),
        gender: z.string().optional(),
        hasSeat: z.string().optional(),
        sort: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional()
    }).passthrough()
});

const changePassword = z.object({
    body: z.object({
        currentPassword: z.string().min(1, 'Current password is required'),
        newPassword: z.string().min(6, 'New password must be at least 6 characters')
    })
});

module.exports = {
    createStudent,
    updateStudent,
    assignPlan,
    markAsPaid,
    changePlan,
    renew,
    updateMyProfile,
    renewRequest,
    pauseMembership,
    resumeMembership,
    extendMembership,
    setStatus,
    addNote,
    listStudents,
    changePassword
};
