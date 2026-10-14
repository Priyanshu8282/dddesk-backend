const { z } = require('zod');

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const dateish = z.preprocess((v) => (v === '' ? null : v), z.coerce.date().nullable());

// ---------- announcements ----------
const annFields = {
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
    audience: z.enum(['owners', 'staff', 'students', 'all']),
    severity: z.enum(['info', 'warning', 'critical']),
    startsAt: dateish,
    endsAt: dateish,
    isActive: z.boolean()
};
const dateOrder = (b) => !b.startsAt || !b.endsAt || b.endsAt > b.startsAt;
const dateMsg = { message: 'endsAt must be after startsAt', path: ['endsAt'] };

const createAnnouncement = z.object({
    body: z.object(annFields).partial().required({ title: true, body: true }).strict().refine(dateOrder, dateMsg)
});
const updateAnnouncement = z.object({
    params: z.object({ id: objectId }),
    body: z.object(annFields).partial().strict().refine(dateOrder, dateMsg)
});
const idParam = z.object({ params: z.object({ id: objectId }) });
const listAnnouncements = z.object({
    query: z.object({
        audience: z.enum(['owners', 'staff', 'students', 'all']).optional(),
        isActive: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional()
    }).passthrough()
});

// ---------- notification providers ----------
// Secrets are NEVER accepted: only names of environment variables, restricted to notification-related prefixes
// so a provider setting can not be pointed at JWT_SECRET, DB URIs, etc.
const envVarName = z.string().trim().regex(/^(SMTP|MAIL|EMAIL|SMS|WHATSAPP|WA|NOTIFY|TWILIO|MSG91)_[A-Z0-9_]{1,50}$/,
    'Must be the NAME of an environment variable (e.g. SMTP_PASS), not the secret itself');
const host = z.string().trim().min(3).max(253).regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, 'Invalid host name');
const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'Invalid provider name');

const email = z.object({
    enabled: z.boolean(),
    host: host.nullable(),
    port: z.coerce.number().int().min(1).max(65535).nullable(),
    secure: z.boolean(),
    user: z.string().trim().min(1).max(200).nullable(),
    from: z.string().trim().min(3).max(200).nullable(),
    passwordEnvVar: envVarName.nullable()
}).partial().strict();
const sms = z.object({
    enabled: z.boolean(),
    provider: slug.nullable(),
    senderId: z.string().trim().regex(/^[A-Za-z0-9]{3,11}$/, 'Sender id must be 3-11 letters/digits').nullable(),
    apiKeyEnvVar: envVarName.nullable()
}).partial().strict();
const whatsapp = z.object({
    enabled: z.boolean(),
    provider: slug.nullable(),
    phoneNumberId: z.string().trim().regex(/^[0-9]{5,30}$/, 'phoneNumberId must be numeric').nullable(),
    accessTokenEnvVar: envVarName.nullable()
}).partial().strict();

const updateProviders = z.object({
    body: z.object({ email: email.optional(), sms: sms.optional(), whatsapp: whatsapp.optional() }).strict()
        .refine((b) => b.email || b.sms || b.whatsapp, { message: 'Provide at least one of email, sms, whatsapp' })
});

const systemEvents = z.object({
    query: z.object({
        limit: z.coerce.number().int().min(1).max(50).optional(),
        days: z.coerce.number().int().min(1).max(90).optional()
    }).passthrough()
});

module.exports = { createAnnouncement, updateAnnouncement, idParam, listAnnouncements, updateProviders, systemEvents, envVarName };
