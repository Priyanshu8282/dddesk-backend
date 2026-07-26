const express = require("express");
const cors = require("cors");
const httpStatus = require("http-status");
const ApiError = require("./utils/ApiError");
const helmet = require("helmet");
const publicRoutes = require('./routes/v1/public');
const privateRoutes = require('./routes/v1/private');

const app = express();
// Analytics visitor tracking routes registered via public.js

// enable cors
app.use(cors());
app.options(/.*/, cors());

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

app.use('/uploads', express.static('uploads'));

//parse json request body
app.use(express.json());
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

// handle error
app.use((err, req, res, next) => {
    let { statusCode, message } = err;
    if (err.code === 'ENOENT') {
        statusCode = 404;
        message = 'Requested file or resource not found';
    }
    if (!statusCode || typeof statusCode !== 'number') statusCode = 500;

    res.locals.errorMessage = err.message;

    const response = {
        code: statusCode,
        message,
        ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
    };

    if (process.env.NODE_ENV === "development") {
        console.error(err);
    }

    res.status(statusCode).send(response);
});

module.exports = app;
