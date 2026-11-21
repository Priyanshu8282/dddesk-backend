const { z } = require('zod');

// Public marketing-site chatbot. No library/account context: this is the one Gemini-backed endpoint
// reachable by anonymous visitors, so the body is deliberately small and strict.
const turn = z.strictObject({
    role: z.enum(['user', 'assistant']),
    text: z.string().trim().min(1).max(600),
});

const chat = z.object({
    body: z.strictObject({
        message: z.string().trim().min(1, 'Type a message first.').max(500, 'Please keep your message under 500 characters.'),
        // short recent-history the client replays each turn; the server keeps nothing (see publicChat.service)
        history: z.array(turn).max(6).optional().default([]),
    }),
});

module.exports = { chat };
