const ApiError = require('../utils/ApiError');

const errorHandler = (err, req, res, next) => {
    require('./upload.middleware').cleanupUploadsOnError(req, res);
    let statusCode = err.statusCode || err.status;
    let message = err.message;

    // Handle MongoDB duplicate key error (code 11000)
    if (err.code === 11000) {
        statusCode = 409;
        const field = Object.keys(err.keyPattern || {})[0] || 'field';
        message = `An entry with this ${field} already exists.`;
    }

    // Handle Mongoose CastError (e.g. invalid ObjectId)
    if (err.name === 'CastError') {
        statusCode = 400;
        message = `Invalid ${err.path}`; // the offending value is not echoed back
    }

    // Handle Mongoose ValidationError
    if (err.name === 'ValidationError') {
        statusCode = 400;
        message = Object.values(err.errors)
            .map((e) => e.message)
            .join(', ');
    }

    // Handle file not found
    if (err.code === 'ENOENT') {
        statusCode = 404;
        message = 'Requested file or resource not found';
    }

    if (!statusCode || typeof statusCode !== 'number') {
        statusCode = 500;
    }

    // Server faults never leak internals (driver messages, paths, query details) outside development
    const isProd = process.env.NODE_ENV === 'production';
    if (statusCode >= 500) {
        console.error(`[${req.id || '-'}] ${req.method} ${(req.originalUrl || '').split('?')[0]} ->`, err && err.stack ? err.stack : err);
        if (isProd) message = 'Internal Server Error';
    }

    const response = {
        success: false,
        code: statusCode,
        message: message || 'Internal Server Error',
        ...(req.id && statusCode >= 500 && { requestId: req.id }),
        ...(err.errorCode && { errorCode: err.errorCode }),
        ...(err.errors && { errors: err.errors }),
        ...(err.data && statusCode < 500 && { data: err.data }),
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    };

    res.status(statusCode).json(response);
};

module.exports = errorHandler;
