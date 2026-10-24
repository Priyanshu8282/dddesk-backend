const { z } = require('zod');
const { normalizeMobile } = require('../utils/mobile');
const { isValidAadhaar } = require('../utils/aadhaar');
const { isMinor, toBool, minorGuardianIssues } = require('../utils/dpdp');

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const emptyToUndef = (v) => (v === '' || v === null ? undefined : v);
// Indian mobile: 10 digits starting 6-9. +91 / 91 / 0 prefixes, spaces and dashes are accepted and stripped.
const mobile = z.string().trim().transform((v) => normalizeMobile(v)).refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit Indian mobile number (starts with 6-9)');
const optionalMobile = z.preprocess(emptyToUndef, mobile.optional());
const pincode = z.preprocess(emptyToUndef, z.string().trim().regex(/^[1-9]\d{5}$/, 'Pincode must be 6 digits').optional());
const aadhaar = z.preprocess(emptyToUndef, z.string().trim().refine(isValidAadhaar, 'Aadhaar number is not valid (12 digits, starting 2-9, correct check digit)').optional());
// multipart bodies deliver booleans as 'true' / 'false' strings
const flag = z.preprocess((v) => (v === undefined || v === '' ? undefined : toBool(v)), z.boolean().optional());

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
    aadhaarNumber: aadhaar,
    guardianName: z.string().trim().max(100).optional(),
    guardianMobile: optionalMobile,
    guardianRelation: z.string().trim().max(50).optional(),
    guardianOccupation: z.string().optional(),
    consentGiven: flag,
    guardianConsentGiven: flag,
    emergencyContact: emergencyContact.optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    countryCode: z.string().optional(),
    stateCode: z.string().optional(),
    pincode,
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
        if (!b.consentGiven) {
            ctx.addIssue({ code: 'custom', path: ['consentGiven'], message: "The student's consent to data processing is required" });
        }
        if (b.dob && isMinor(b.dob)) {
            minorGuardianIssues({ name: b.guardianName, mobile: b.guardianMobile, consentGiven: b.guardianConsentGiven })
                .forEach((i) => ctx.addIssue({ code: 'custom', path: [i.path], message: i.message }));
        }
    })
});

// Rows are checked one by one in the service so a bad row is reported, not fatal; here we only bound the payload
const importCell = z.union([z.string().max(300), z.number(), z.null()]).optional();
const importStudents = z.object({
    body: z.object({
        dryRun: z.boolean().optional(),
        // The person importing confirms consent (and guardian consent for under-18s) was collected for every row
        consentConfirmed: z.boolean().optional(),
        branchId: z.preprocess(emptyToUndef, objectId.optional()),
        rows: z.array(z.object({
            rowNumber: z.number().int().positive().optional(),
            name: importCell, mobile: importCell, email: importCell, gender: importCell, dob: importCell, joiningDate: importCell,
            rollNumber: importCell, aadhaarNumber: importCell, guardianName: importCell, guardianMobile: importCell,
            address: importCell, city: importCell, state: importCell, pincode: importCell, plan: importCell, seatNumber: importCell
        })).min(1, 'The file has no student rows').max(100, 'Send at most 100 rows per request')
    })
});

const updateStudent = z.object({
    body: z.object({
        ...studentFields,
        name: studentFields.name.optional(),
        mobile: mobile.optional(),
        documentType: z.string().optional()
    }).superRefine((b, ctx) => {
        // Only checked when the request touches the guardian block together with the date of birth, so editing
        // an address on a legacy record is never blocked; the service re-checks against the stored record.
        if (b.dob && isMinor(b.dob) && (b.guardianName !== undefined || b.guardianMobile !== undefined || b.guardianConsentGiven !== undefined)) {
            minorGuardianIssues({ name: b.guardianName, mobile: b.guardianMobile, consentGiven: b.guardianConsentGiven })
                .forEach((i) => ctx.addIssue({ code: 'custom', path: [i.path], message: i.message }));
        }
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
        remarks: z.string().max(500).optional(),
        // idempotency key: a retry with the same key returns the original receipt instead of charging twice
        requestId: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/).optional()
    })
});

const changePlan = z.object({
    body: z.object({
        planId: objectId,
        startDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        reason: z.string().max(300).optional(),
        // collected at once against the new charge (required when the library does not allow credit)
        paidNow: z.preprocess(emptyToUndef, z.coerce.number().min(0).max(10000000).optional()),
        paymentMethod: z.enum(['cash', 'online', 'upi', 'card', 'bank_transfer', 'cheque', 'other']).optional(),
        reference: z.string().max(100).optional(),
        requestId: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/).optional()
    })
});

const renew = z.object({
    body: z.object({
        planId: z.preprocess(emptyToUndef, objectId.optional()),
        startDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        keepSeat: z.boolean().optional().default(true),
        dueDate: z.preprocess(emptyToUndef, z.coerce.date().optional()),
        couponCode: z.preprocess(emptyToUndef, z.string().trim().min(1).max(40).optional()),
        referrerId: z.preprocess(emptyToUndef, objectId.optional()),
        paidNow: z.preprocess(emptyToUndef, z.coerce.number().min(0).max(10000000).optional()),
        paymentMethod: z.enum(['cash', 'online', 'upi', 'card', 'bank_transfer', 'cheque', 'other']).optional(),
        reference: z.string().max(100).optional(),
        requestId: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/).optional()
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

// Erasure is irreversible: the caller must give a reason and type the confirmation word
const eraseStudent = z.object({
    body: z.object({
        reason: z.string().trim().min(3, 'A reason for the erasure is required').max(300),
        confirm: z.literal('ERASE', { error: 'Type ERASE to confirm' })
    })
});

const retentionQuery = z.object({
    query: z.object({ days: z.coerce.number().int().min(1).max(3650).optional() }).passthrough()
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
    importStudents,
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
    eraseStudent,
    retentionQuery,
    listStudents,
    changePassword
};
