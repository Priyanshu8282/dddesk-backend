const Library = require('../models/library.model');
const LibraryWebsite = require('../models/libraryWebsite.model');

// Sub-domains that can never be a tenant
const RESERVED_SLUGS = [
    'admin', 'api', 'www', 'app', 'mail', 'smtp', 'ftp', 'static', 'assets', 'cdn',
    'dev', 'staging', 'test', 'demo', 'support', 'help', 'blog', 'docs', 'status',
    'superadmin', 'super', 'dashboard', 'login', 'register', 'public', 'private',
    'dddesk', 'root', 'system', 'billing', 'auth'
];

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

const baseDomain = () => (process.env.BASE_DOMAIN || 'dddesk.ai').toLowerCase().replace(/^\.+/, '');

const ERRORS = {
    TENANT_NOT_FOUND:   { status: 404, message: 'Library website not found.' },
    TENANT_INACTIVE:    { status: 403, message: 'This library is currently not active.' },
    SITE_NOT_PUBLISHED: { status: 404, message: 'This library website is not published yet.' },
    SLUG_MOVED:         { status: 301, message: 'This library website has moved.' }
};

const normalizeHost = (raw = '') => {
    let h = String(raw).split(',')[0].trim().toLowerCase();
    h = h.replace(/^https?:\/\//, '').split('/')[0];
    h = h.replace(/:\d+$/, '');       // strip port
    return h.replace(/\.$/, '');      // trailing dot
};

const isLocalHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');

const cleanSlug = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

const canonicalUrl = (library) => {
    if (library.customDomain && library.domainVerified) return `https://${library.customDomain}`;
    return `https://${library.slug}.${baseDomain()}`;
};

/**
 * Find a library by current slug, else by one of its previous slugs.
 * Returns { library, moved } where moved=true when matched through previousSlugs.
 */
const findLibraryBySlug = async (slug) => {
    if (!slug || !SLUG_RE.test(slug) && !/^[a-z0-9-]{2,60}$/.test(slug)) return { library: null };
    const base = { isDeleted: { $ne: true } };
    let library = await Library.findOne({ ...base, slug })
        .select('name slug previousSlugs status customDomain domainVerified logo profileImage')
        .lean();
    if (library) return { library, moved: false };
    library = await Library.findOne({ ...base, previousSlugs: slug })
        .select('name slug previousSlugs status customDomain domainVerified logo profileImage')
        .lean();
    return library ? { library, moved: true } : { library: null };
};

const findLibraryByDomain = async (domain) =>
    Library.findOne({ isDeleted: { $ne: true }, customDomain: domain, domainVerified: true })
        .select('name slug previousSlugs status customDomain domainVerified logo profileImage')
        .lean();

/**
 * Turn a located library into the final decision (status / published checks).
 * Result: { library, website, slug, reason, status, message, redirectTo? }
 * reason is null when the tenant is usable.
 */
const evaluateTenant = async (library, { moved = false, requirePublished = true } = {}) => {
    if (!library) return { library: null, reason: 'TENANT_NOT_FOUND', ...ERRORS.TENANT_NOT_FOUND };
    if (moved) {
        return {
            library, slug: library.slug, reason: 'SLUG_MOVED', ...ERRORS.SLUG_MOVED,
            redirectTo: canonicalUrl(library)
        };
    }
    if (library.status !== 'active') {
        return { library, slug: library.slug, reason: 'TENANT_INACTIVE', ...ERRORS.TENANT_INACTIVE };
    }
    const website = await LibraryWebsite.findOne({ libraryId: library._id }).lean();
    if (requirePublished && !(website && website.isPublished === true)) {
        return { library, website, slug: library.slug, reason: 'SITE_NOT_PUBLISHED', ...ERRORS.SITE_NOT_PUBLISHED };
    }
    return { library, website, slug: library.slug, reason: null, status: 200 };
};

/**
 * Resolve the tenant for a request.
 * Order: explicit host override > x-tenant-slug header / ?slug= > x-forwarded-host/host.
 * {slug}.BASE_DOMAIN -> library by slug / previousSlugs; any other host -> verified custom domain.
 */
const resolveTenantFromHost = async (req, { host: hostOverride, requirePublished = true } = {}) => {
    const explicitSlug = cleanSlug(req.headers?.['x-tenant-slug'] || req.query?.slug);
    const host = normalizeHost(hostOverride || req.headers?.['x-forwarded-host'] || req.headers?.host || '');
    const base = baseDomain();

    let slug = '';
    let library = null;
    let moved = false;

    if (!hostOverride && explicitSlug) {
        slug = explicitSlug;
    } else if (host === base || host === `www.${base}`) {
        return evaluateTenant(null);
    } else if (host.endsWith(`.${base}`)) {
        const sub = host.slice(0, -(base.length + 1));
        if (sub.includes('.') || RESERVED_SLUGS.includes(sub)) return evaluateTenant(null);
        slug = sub;
    } else if (host && !isLocalHost(host)) {
        library = await findLibraryByDomain(host);
        return evaluateTenant(library, { requirePublished });
    } else {
        return evaluateTenant(null);
    }

    if (RESERVED_SLUGS.includes(slug)) return evaluateTenant(null);
    const found = await findLibraryBySlug(slug);
    library = found.library;
    moved = !!found.moved;
    return evaluateTenant(library, { moved, requirePublished });
};

/** Resolve by slug only (used by /public/website/:slug routes). */
const resolveTenantBySlug = async (rawSlug, { requirePublished = true } = {}) => {
    const slug = cleanSlug(rawSlug);
    if (!slug || RESERVED_SLUGS.includes(slug)) return evaluateTenant(null);
    const { library, moved } = await findLibraryBySlug(slug);
    return evaluateTenant(library, { moved: !!moved, requirePublished });
};

const sendTenantError = (res, t) => {
    const body = { success: false, code: t.reason, statusCode: t.status, message: t.message };
    if (t.reason === 'SLUG_MOVED') {
        body.redirectTo = t.redirectTo;
        body.newSlug = t.slug;
    }
    return res.status(t.status).json(body);
};

/** Express middleware: resolves :slug param into req.tenant, enforcing active + published. */
const tenantFromSlugParam = (opts = {}) => async (req, res, next) => {
    try {
        const t = await resolveTenantBySlug(req.params.slug, opts);
        if (t.reason) return sendTenantError(res, t);
        req.tenant = t;
        return next();
    } catch (e) {
        return next(e);
    }
};

/** Express middleware: resolves tenant from the Host header / x-tenant-slug. */
const tenantFromHost = (opts = {}) => async (req, res, next) => {
    try {
        const t = await resolveTenantFromHost(req, opts);
        if (t.reason) return sendTenantError(res, t);
        req.tenant = t;
        return next();
    } catch (e) {
        return next(e);
    }
};

module.exports = {
    RESERVED_SLUGS, SLUG_RE, baseDomain, normalizeHost, canonicalUrl,
    resolveTenantFromHost, resolveTenantBySlug, sendTenantError,
    tenantFromSlugParam, tenantFromHost
};
