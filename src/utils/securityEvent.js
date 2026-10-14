const audit = require('./audit');

// Records a tenant-isolation violation attempt (a request referenced a record of another library).
// logSecurityEvent(req, 'tenant_mismatch', { resource: 'Student', id })  -> AuditLog action 'security.tenant_mismatch'
// Fire-and-forget; never throws.
const logSecurityEvent = (req, type, details = {}) => {
    try {
        const { resource = 'Security', id = null, ...rest } = details;
        const meta = { ...rest, method: req.method, path: req.originalUrl };
        audit(req, `security.${type}`, resource, id || null, meta).catch(() => {});
    } catch (_) { /* never break the request */ }
};

// True when a record with this id exists but in another library (call only after a scoped lookup missed)
const flagIfOtherTenant = async (req, Model, id, resource) => {
    try {
        if (!id || !req?.libraryId) return false;
        const other = await Model.exists({ _id: id, libraryId: { $ne: req.libraryId } });
        if (other) { logSecurityEvent(req, 'tenant_mismatch', { resource, id }); return true; }
    } catch (_) { /* ignore */ }
    return false;
};

module.exports = { logSecurityEvent, flagIfOtherTenant };

// Runs fn(); if it rejects with 400/404 and `id` belongs to another library, logs a tenant_mismatch event, then rethrows.
const flagOnMiss = async (req, Model, id, resource, fn) => {
    try { return await fn(); }
    catch (e) {
        if (e && (e.status === 404 || e.status === 400)) await flagIfOtherTenant(req, Model, id, resource);
        throw e;
    }
};

module.exports.flagOnMiss = flagOnMiss;
