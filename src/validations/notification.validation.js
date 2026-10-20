const { z } = require('zod');

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-04-30');

const listQuery = z.object({
    query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        status: z.enum(['all', 'unread', 'read']).optional(),
        type: z.string().trim().max(60).optional(),
        search: z.string().trim().max(80).optional(),
        from: day.optional(),
        to: day.optional(),
        sort: z.enum(['newest', 'oldest']).optional(),
    })
});

const send = z.object({
    body: z.object({
        audience: z.enum(['all', 'active', 'expiring', 'expired', 'pending'], 'Choose who should receive this'),
        title: z.string('Title is required').trim().min(3, 'Title must be at least 3 characters').max(100, 'Title is too long (100 characters max)'),
        message: z.string('Message is required').trim().min(5, 'Message must be at least 5 characters').max(500, 'Message is too long (500 characters max)'),
        channels: z.array(z.enum(['inapp', 'push', 'email', 'sms', 'whatsapp'])).max(5).optional(),
    })
});

module.exports = { listQuery, send };
