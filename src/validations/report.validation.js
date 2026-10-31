const { z } = require('zod');

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'Use YYYY-MM-DD');
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const text = (n = 60) => z.string().trim().max(n);

// Filters shared by all report endpoints. Unknown keys are dropped by zod.
const common = {
    startDate: day.optional(),
    endDate: day.optional(),
    branchId: objectId.optional(),
    libraryId: objectId.optional(), // honoured for superadmin only (tenantId)
    floor: text().optional(),
    room: text().optional(),
    type: text(30).optional(),
    planId: objectId.optional(),
    status: text(30).optional(),
    method: z.enum(['cash', 'upi', 'online', 'bank_transfer', 'other']).optional(),
    paymentType: z.enum(['new', 'renewal', 'partial', 'advance']).optional(),
    source: z.enum(['website', 'walk-in', 'referral', 'phone', 'other']).optional(),
    category: text(30).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    search: text().optional(),
    page: z.coerce.number().int().min(1).max(100000).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    days: z.coerce.number().int().min(1).max(365).optional(),
    expiringInDays: z.coerce.number().int().min(1).max(365).optional()
};

const q = (extra = {}) => z.object({ query: z.object({ ...common, ...extra }).optional().default({}) });

const dateRangeQuery = q({ view: z.enum(['collection', 'all', 'dues', 'overdue', 'refunds', 'credit', 'partial']).optional() });
const studentReportQuery = q({ view: z.enum(['master', 'active', 'inactive', 'joining', 'expiry', 'expired', 'renewals']).optional() });
const attendanceQuery = q({ view: z.enum(['logs', 'daily', 'monthly', 'student', 'shift']).optional() });
const membershipQuery = q({ view: z.enum(['new', 'renewals', 'expiring', 'expired']).optional() });
const enquiryQuery = q({ view: z.enum(['all', 'followups']).optional() });
const plainQuery = q();

const dataQuery = z.object({
    params: z.object({ type: z.string().regex(/^[a-z_]{3,40}$/) }),
    query: z.object(common).optional().default({})
});

const EXPORT_TYPES = [
    'students', 'students_active', 'students_inactive', 'students_joining', 'students_expiry', 'membership_expired',
    'payments', 'payments_all', 'dues', 'overdue', 'refunds', 'credit', 'partial', 'renewals',
    'seats', 'seat_history', 'attendance', 'attendance_daily', 'attendance_monthly', 'attendance_student', 'attendance_shift',
    'expenses', 'complaints', 'enquiries', 'enquiry_followups', 'website_enquiries',
    'collection', 'membership_new', 'membership_expiring', 'membership_renewals', 'seat_occupancy', 'enquiry'
];

const exportQuery = z.object({
    query: z.object({
        ...common,
        type: z.enum(EXPORT_TYPES, { error: () => ({ message: `Export type must be one of: ${EXPORT_TYPES.join(', ')}` }) }),
        format: z.enum(['csv', 'xlsx', 'xls', 'json']).optional().default('csv')
    })
});

const biQuery = z.object({
    query: z.object({
        startDate: day.optional(),
        endDate: day.optional(),
        branchId: objectId.optional(),
        libraryId: objectId.optional(),
        granularity: z.enum(['day', 'month']).optional(),
        listLimit: z.coerce.number().int().min(1).max(50).optional()
    }).optional().default({})
});

module.exports = {
    dateRangeQuery, studentReportQuery, attendanceQuery, membershipQuery, enquiryQuery, plainQuery,
    dataQuery, exportQuery, biQuery, EXPORT_TYPES
};
