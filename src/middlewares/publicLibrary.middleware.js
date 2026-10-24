const mongoose = require('mongoose');
const Library = require('../models/library.model');
const LibraryWebsite = require('../models/libraryWebsite.model');

const ERRORS = {
    TENANT_NOT_FOUND:   { status: 404, message: 'Library website not found.' },
    TENANT_INACTIVE:    { status: 403, message: 'This library is currently not active.' },
    SITE_NOT_PUBLISHED: { status: 404, message: 'This library website is not published yet.' }
};

/**
 * Resolve a library by its id for the public website API.
 * Result: { library, website, reason, status, message }; reason is null when the library is usable.
 */
const resolveTenantById = async (rawId, { requirePublished = true } = {}) => {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!mongoose.isValidObjectId(id) || !/^[a-f\d]{24}$/i.test(id)) {
        return { library: null, reason: 'TENANT_NOT_FOUND', ...ERRORS.TENANT_NOT_FOUND };
    }
    const library = await Library.findOne({ _id: id, isDeleted: { $ne: true } })
        .select('name status logo profileImage').lean();
    if (!library) return { library: null, reason: 'TENANT_NOT_FOUND', ...ERRORS.TENANT_NOT_FOUND };
    if (library.status !== 'active') return { library, reason: 'TENANT_INACTIVE', ...ERRORS.TENANT_INACTIVE };
    const website = await LibraryWebsite.findOne({ libraryId: library._id }).lean();
    if (requirePublished && !(website && website.isPublished === true)) {
        return { library, website, reason: 'SITE_NOT_PUBLISHED', ...ERRORS.SITE_NOT_PUBLISHED };
    }
    return { library, website, reason: null, status: 200 };
};

const sendTenantError = (res, t) =>
    res.status(t.status).json({ success: false, code: t.reason, statusCode: t.status, message: t.message });

/** Express middleware: resolves the :libraryId param into req.tenant, enforcing active + published. */
const tenantFromIdParam = (opts = {}) => async (req, res, next) => {
    try {
        const t = await resolveTenantById(req.params.libraryId, opts);
        if (t.reason) return sendTenantError(res, t);
        req.tenant = t;
        return next();
    } catch (e) {
        return next(e);
    }
};

module.exports = { resolveTenantById, sendTenantError, tenantFromIdParam };
