const express = require("express");
const cors = require("cors");
const httpStatus = require("http-status");
const ApiError = require("./utils/ApiError");
const helmet = require("helmet");
const publicRoutes = require('./routes/public');
const privateRoutes = require('./routes/private');
const errorHandler = require('./middlewares/error.middleware');
const { sanitizeInput, parameterPollutionGuard, extraHeaders } = require('./middlewares/security.middleware');
const { apiLimiter } = require('./middlewares/rateLimit.middleware');

const app = express();

// Behind Vercel/proxies: real client IP for rate limiting and audit logs
app.set('trust proxy', 1);

// Exact-origin CORS (config/cors.js): ALLOWED_ORIGINS + FRONTEND_URL + the frontend URL saved in Platform Settings
const { corsOptions } = require('./config/cors');
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// Security headers. This server only returns JSON and files: nothing it sends may be framed or run as a page.
app.disable('x-powered-by');
app.use(
    helmet({
        // images/files are loaded by the frontend from another origin
        crossOriginResourcePolicy: { policy: "cross-origin" },
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                "default-src": ["'none'"],
                "frame-ancestors": ["'none'"],
                "base-uri": ["'none'"],
                "form-action": ["'none'"],
            },
        },
        frameguard: { action: "deny" },
        referrerPolicy: { policy: "no-referrer" },
        hsts: { maxAge: 31536000, includeSubDomains: true },
    })
);
app.use(extraHeaders);

// Uploaded files: never let the browser sniff or execute them
const INLINE_OK = /[.](png|jpe?g|gif|webp)$/i;
app.use('/uploads', (req, res, next) => {
    // Personal documents (Aadhaar, ID proofs) are served only through the authenticated /v1/private/files route
    if (/^[/]documents([/]|$)/i.test(req.path)) return res.status(404).json({ success: false, code: 404, message: 'File not found' });
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
    next();
}, express.static('uploads', {
    dotfiles: 'deny', index: false,
    // anything that is not a plain image is downloaded, never rendered in the browser
    setHeaders: (res, filePath) => { if (!INLINE_OK.test(filePath)) res.set('Content-Disposition', 'attachment'); },
}));

// Request bodies: small by default (keep the raw bytes for payment webhook signature checks)
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '200kb', parameterLimit: 200 }));
// Strip Mongo operators ($gt, a.b) and prototype keys from body/query; cap repeated query params
app.use(sanitizeInput);
app.use(parameterPollutionGuard);
// Whole-API flood guard per client IP (the webhook below is mounted at the root and is not counted)
app.use('/v1', apiLimiter);


// Root open route
app.get("/", (req, res) => {
    res.status(200).json({
        status: "success",
        message: "Server is running",
        timestamp: new Date().toISOString()
    });
});

// Razorpay webhook endpoint (root level)
const razorpayController = require('./controllers/razorpay.controller');
app.post('/webhook/razorpay', razorpayController.webhookHandler);

// Maintenance gate for public routes (private routes are decided after sign-in; the webhook above is never blocked)
app.use('/v1', require('./middlewares/maintenance.middleware'));

//Api routes
// Scheduled jobs for serverless hosting (secured with CRON_SECRET)
app.use('/v1/cron', require('./routes/cron.routes'));

app.use('/v1/private', privateRoutes); // Private routes

// Use public routes for /v1/public
app.use('/v1/public', publicRoutes); // Public routes

// Default catch-all for /v1 (fallback)
app.use("/v1", publicRoutes);

// Catch-all for undefined routes
app.use((req, res, next) => {
    next(new ApiError(404, "Not found"));
});

// Centralized error handling middleware
app.use(errorHandler);

module.exports = app;
