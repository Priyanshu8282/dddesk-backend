const ApiError = require('../utils/ApiError');

const errorHandler = (err, req, res, next) => {
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
        message = `Invalid ${err.path}: ${err.value}`;
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

    const response = {
        success: false,
        code: statusCode,
        message: message || 'Internal Server Error',
        ...(err.errors && { errors: err.errors }),
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    };

    if (process.env.NODE_ENV === 'development') {
        console.error('Error Handler Caught:', err);
    }

    res.status(statusCode).json(response);
};

module.exports = errorHandler;
