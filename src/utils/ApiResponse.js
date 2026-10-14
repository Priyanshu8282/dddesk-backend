class ApiResponse {
    constructor(statusCode, data, message = "Success", meta = null) {
        this.success = statusCode < 400;
        this.statusCode = statusCode;
        this.message = message;
        this.data = data;
        if (meta) this.meta = meta;
    }

    static success(res, data = null, message = "Success", statusCode = 200, extra = null) {
        const payload = {
            success: true,
            statusCode,
            message,
            data,
            ...(extra && typeof extra === 'object' ? extra : {})
        };
        return res.status(statusCode).json(payload);
    }

    static created(res, data = null, message = "Created successfully", extra = null) {
        return ApiResponse.success(res, data, message, 201, extra);
    }

    static ok(res, data = null, message = "Success", extra = null) {
        return ApiResponse.success(res, data, message, 200, extra);
    }

    static error(res, message = "Something went wrong", statusCode = 500, errors = null) {
        const payload = {
            success: false,
            code: statusCode,
            message
        };
        if (errors) payload.errors = errors;
        return res.status(statusCode).json(payload);
    }
}

module.exports = ApiResponse;
