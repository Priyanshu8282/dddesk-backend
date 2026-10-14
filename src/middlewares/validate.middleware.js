const ApiError = require('../utils/ApiError');

/**
 * Middleware factory for validating Express request objects using Zod schemas.
 * Validates req.body, req.query, and req.params against a defined schema.
 */
const validate = (schema) => (req, res, next) => {
    try {
        const validated = schema.parse({
            body: req.body,
            query: req.query,
            params: req.params,
        });

        // Assign sanitized / coerced values back to request
        if (validated.body) req.body = validated.body;
        if (validated.query) req.query = validated.query;
        if (validated.params) req.params = validated.params;

        return next();
    } catch (err) {
        const issues = err.issues || err.errors;
        if (issues && Array.isArray(issues)) {
            const formattedErrors = issues.map((e) => {
                const cleanField = e.path
                    .join('.')
                    .replace(/^(body|query|params)\./, '')
                    .replace(/^(body|query|params)$/, '');
                return {
                    field: cleanField || 'field',
                    message: e.message,
                };
            });

            const message = formattedErrors
                .map((e) => (e.field && e.field !== 'field' ? `${e.field}: ${e.message}` : e.message))
                .join(', ');

            return res.status(400).json({
                success: false,
                code: 400,
                message: message || 'Validation failed',
                errors: formattedErrors,
            });
        }
        return next(new ApiError(400, err.message));
    }
};

module.exports = validate;
