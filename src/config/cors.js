// Single source of truth for which browser origins may call the API (CORS) and may use the cookie endpoints.
// Exact origins only: ALLOWED_ORIGINS (comma list) + FRONTEND_URL + the frontend URL saved in Platform Settings.
// Wildcards are ignored on purpose. Localhost is allowed only outside production.
const normalize = (o) => {
    try { return new URL(String(o).trim()).origin; } catch (_) { return null; }
};

const fromEnv = () => [process.env.ALLOWED_ORIGINS, process.env.FRONTEND_URL]
    .join(',').split(',').map((s) => s.trim()).filter((s) => s && !s.includes('*')).map(normalize).filter(Boolean);

const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'];

const allowedOrigins = () => {
    const list = new Set(fromEnv());
    try {
        for (const o of require('../services/platformSettings.service').extraAllowedOrigins()) {
            const n = normalize(o);
            if (n) list.add(n);
        }
    } catch (_) { /* settings not loaded yet */ }
    if (process.env.NODE_ENV !== 'production') DEV_ORIGINS.forEach((o) => list.add(o));
    return list;
};

/** True when the browser origin is explicitly allowed. */
const isAllowedOrigin = (origin) => !!origin && allowedOrigins().has(normalize(origin));

const corsOptions = {
    origin: (origin, callback) => {
        // Requests without an Origin header (mobile apps, server-to-server, curl) are not browsers: Bearer auth protects them
        if (!origin || isAllowedOrigin(origin)) return callback(null, true);
        return callback(null, false); // no CORS headers: the browser blocks the response (no 500, no stack trace)
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Idempotency-Key', 'X-Session-Persist', 'X-Registration-Token', 'X-Human-Token', 'X-Client-Platform', 'X-Client-Type', 'X-App-Version'],
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After', 'X-New-Access-Token', 'X-New-Access-Token-Expires-In'],
    maxAge: 86400,
};

module.exports = { corsOptions, isAllowedOrigin, allowedOrigins, normalize };
