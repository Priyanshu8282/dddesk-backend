const crypto = require('crypto');

// Subdomains that must never be handed to a tenant
// Union of the platform list and the tenant-host resolver list (middlewares/tenantHost.middleware.js) - keep in sync
const RESERVED_SLUGS = [
  'admin', 'api', 'www', 'app', 'mail', 'smtp', 'ftp', 'static', 'assets', 'cdn',
  'dev', 'staging', 'test', 'demo', 'support', 'help', 'blog', 'docs', 'status',
  'superadmin', 'super', 'dashboard', 'login', 'register', 'public', 'private',
  'dddesk', 'root', 'system', 'billing', 'auth',
];

const slugify = (s = '') =>
  String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 50).replace(/-+$/g, '');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const isReserved = (slug) => RESERVED_SLUGS.includes(String(slug).toLowerCase());
const isValidSlug = (slug) => SLUG_RE.test(slug) && !isReserved(slug);

// A slug is taken if any other library uses it now or used it before (old links must keep working)
const isTaken = async (Library, slug, excludeId) => {
  const q = { $or: [{ slug }, { previousSlugs: slug }] };
  if (excludeId) q._id = { $ne: excludeId };
  return !!(await Library.exists(q));
};

// Unique slug with numeric suffix; random suffix as a last resort
const generateUniqueSlug = async (name, { excludeId = null } = {}) => {
  const Library = require('../models/library.model');
  let base = slugify(name);
  if (base.length < 3) base = `library-${base}`.replace(/-$/, '');
  if (isReserved(base)) base = `${base}-library`;
  let candidate = base;
  for (let i = 2; i < 200; i++) {
    if (!isReserved(candidate) && !(await isTaken(Library, candidate, excludeId))) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
};

module.exports = { RESERVED_SLUGS, slugify, isValidSlug, isReserved, isTaken, generateUniqueSlug };
