const express = require("express");
const cors = require("cors");
const httpStatus = require("http-status");
const ApiError = require("./utils/ApiError");
const helmet = require("helmet");
const publicRoutes = require('./routes/public');
const privateRoutes = require('./routes/private');
const errorHandler = require('./middlewares/error.middleware');

const app = express();

// Behind Vercel/proxies: real client IP for rate limiting and audit logs
app.set('trust proxy', 1);

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'];

const corsOptions = {
    origin: (origin, callback) => {
        // Tenant websites live on {slug}.BASE_DOMAIN
        const baseDomain = (process.env.BASE_DOMAIN || 'dddesk.ai').toLowerCase();
        let tenantOrigin = false;
        try {
            const host = origin ? new URL(origin).hostname.toLowerCase() : '';
            tenantOrigin = host === baseDomain || host.endsWith('.' + baseDomain);
        } catch (e) { /* invalid origin */ }
        if (!origin || allowedOrigins.includes(origin) || tenantOrigin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-slug'],
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// Configure Helmet with custom CSP and CORS settings
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: "cross-origin" },
        contentSecurityPolicy: {
            directives: {
                ...helmet.contentSecurityPolicy.getDefaultDirectives(),
                "img-src": ["'self'", "data:", "*"],
                "frame-ancestors": ["*"],
            },
        },
    })
);

// Uploaded files: never let the browser sniff or execute them
app.use('/uploads', (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; sandbox");
    next();
}, express.static('uploads', { dotfiles: 'deny', index: false }));

//parse json request body (keep the raw bytes for payment webhook signature checks)
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
//parse urlencoded request body
app.use(express.urlencoded({ extended: true }));


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

//Api routes
app.use('/v1/private', privateRoutes); // Private routes

// Use public routes for /v1/public
app.use('/v1/public', publicRoutes); // Public routes

// Default catch-all for /v1 (fallback)
app.use("/v1", publicRoutes);

//Api routes
app.use((req, res, next) => {
    next(new ApiError(httpStatus.NOT_FOUND, "Not found"));
});

// Centralized error handling middleware
app.use(errorHandler);

module.exports = app;
