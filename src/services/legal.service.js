const LegalDocument = require('../models/legalDocument.model');
const Version = require('../models/legalDocumentVersion.model');
require('../models/admin.model'); // registers the Admin schema used to show who published a version
const ApiError = require('../utils/ApiError');
const html = require('../utils/legalHtml');
const defaults = require('../seed/legalDefaults');

const TYPES = LegalDocument.TYPES;
const LABELS = { privacy_policy: 'Privacy Policy', terms_and_conditions: 'Terms and Conditions', refund_cancellation_policy: 'Refund and Cancellation Policy' };
// the public page paths double as aliases in the API
const SLUGS = { privacy_policy: 'privacy-policy', terms_and_conditions: 'terms', refund_cancellation_policy: 'refund-cancellation' };
const ALIASES = Object.fromEntries([...TYPES.map((t) => [t, t]), ...Object.entries(SLUGS).map(([t, s]) => [s, t])]);

const MIN_TEXT = 20;
const FUTURE_LIMIT_MS = 365 * 24 * 60 * 60 * 1000;
const PAST_SLACK_MS = 5 * 60 * 1000;

// ApiError that also carries a machine-readable code (and data) the error handler passes on
const fail = (status, message, extra = {}) => Object.assign(new ApiError(status, message), { errorCode: extra.code, data: extra.data });

const resolveType = (raw) => {
    const t = ALIASES[String(raw || '').toLowerCase()];
    if (!t) throw new ApiError(404, 'Unknown legal document');
    return t;
};

const SUMMARY_FIELDS = '-contentHtml -contentText';
const summary = (v) => (v ? {
    id: v._id, type: v.type, version: v.version, label: `v${v.version}`, title: v.title, status: v.status, revision: v.revision,
    summaryOfChanges: v.summaryOfChanges || '', effectiveFrom: v.effectiveFrom, publishedAt: v.publishedAt,
    publishedBy: v.publishedBy && v.publishedBy.name ? { id: v.publishedBy._id, name: v.publishedBy.name } : null,
    updatedAt: v.updatedAt, createdAt: v.createdAt, sourceVersion: v.sourceVersion ?? null,
} : null);
const full = (v) => (v ? { ...summary(v), contentHtml: v.contentHtml, contentText: v.contentText, checksum: v.checksum } : null);

let cache = null;
const CACHE_MS = 30 * 1000;
const invalidateCache = () => { cache = null; };

// ---------------------------------------------------------------------------
// First run: the three documents exist and have a published v1 (placeholder text the owner must review)
// ---------------------------------------------------------------------------
let seeding = null;
const ensureDefaults = () => {
    if (!seeding) {
        seeding = (async () => {
            for (const type of TYPES) {
                await LegalDocument.updateOne({ type }, { $setOnInsert: { type, lastVersion: 0 } }, { upsert: true });
                if (await Version.exists({ type })) continue;
                // whoever moves the counter 0 -> 1 creates v1; a concurrent instance simply gets null and moves on
                const claimed = await LegalDocument.findOneAndUpdate({ type, lastVersion: 0 }, { $inc: { lastVersion: 1 } }, { returnDocument: 'after' });
                if (!claimed) continue;
                const d = defaults[type];
                const body = html.clean(d.html);
                const now = new Date();
                try {
                    await Version.create({
                        type, version: 1, title: d.title, contentHtml: body, contentText: html.toText(body), checksum: html.checksum(d.title, body),
                        summaryOfChanges: 'Initial text. To be reviewed by the owner and legal counsel.', status: 'published', effectiveFrom: now, publishedAt: now,
                    });
                } catch (e) { if (e.code !== 11000) throw e; }
            }
        })().catch((e) => { seeding = null; throw e; });
    }
    return seeding;
};

const nextVersion = async (type) => {
    const doc = await LegalDocument.findOneAndUpdate({ type }, { $inc: { lastVersion: 1 } }, { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true });
    return doc.lastVersion;
};

// A scheduled version whose date has arrived becomes the published one (lazily, so it works on serverless hosting too)
const promoteDue = async (type) => {
    const sched = await Version.findOne({ type, status: 'scheduled', effectiveFrom: { $lte: new Date() } }).select('_id version').lean();
    if (!sched) return false;
    // the exclusion keeps a concurrent promotion from archiving the version that has just been promoted
    await Version.updateMany({ type, status: 'published', version: { $ne: sched.version } }, { $set: { status: 'archived' } });
    const r = await Version.updateOne({ _id: sched._id, status: 'scheduled' }, { $set: { status: 'published' } });
    invalidateCache();
    return r.modifiedCount > 0;
};

// ---------------------------------------------------------------------------
// Super admin
// ---------------------------------------------------------------------------
const POP = { path: 'publishedBy', select: 'name' };

exports.list = async () => {
    await ensureDefaults();
    await Promise.all(TYPES.map(promoteDue));
    const rows = await Version.find({ status: { $in: ['published', 'scheduled', 'draft'] } }).select(SUMMARY_FIELDS).populate(POP).lean();
    const counts = await Version.aggregate([{ $group: { _id: '$type', n: { $sum: 1 } } }]);
    const count = Object.fromEntries(counts.map((c) => [c._id, c.n]));
    return TYPES.map((type) => {
        const mine = rows.filter((r) => r.type === type);
        const pick = (s) => summary(mine.find((r) => r.status === s));
        return { type, slug: SLUGS[type], label: LABELS[type], published: pick('published'), scheduled: pick('scheduled'), draft: pick('draft'), versions: count[type] || 0 };
    });
};

exports.listVersions = async (rawType) => {
    const type = resolveType(rawType);
    await ensureDefaults();
    await promoteDue(type);
    const rows = await Version.find({ type }).select(SUMMARY_FIELDS).populate(POP).sort({ version: -1 }).lean();
    return rows.map(summary);
};

exports.getVersion = async (rawType, version) => {
    const type = resolveType(rawType);
    await ensureDefaults();
    const v = await Version.findOne({ type, version }).populate(POP).lean();
    if (!v) throw new ApiError(404, 'Version not found');
    return full(v);
};

exports.compare = async (rawType, a, b) => {
    const [left, right] = await Promise.all([exports.getVersion(rawType, a), exports.getVersion(rawType, b)]);
    return { left, right };
};

const dupDraft = async (type) => {
    const existing = await Version.findOne({ type, status: 'draft' }).select(SUMMARY_FIELDS).lean();
    return fail(409, 'There is already a draft for this document. Edit or delete it first.', { code: 'DRAFT_EXISTS', data: summary(existing) });
};

const makeDraft = async (type, { source, userId }) => {
    if (await Version.exists({ type, status: 'draft' })) throw await dupDraft(type);
    const version = await nextVersion(type);
    const title = source ? source.title : LABELS[type];
    const body = source ? source.contentHtml : '';
    try {
        const v = await Version.create({
            type, version, title, contentHtml: body, contentText: html.toText(body), checksum: html.checksum(title, body),
            status: 'draft', createdBy: userId || null, updatedBy: userId || null, sourceVersion: source ? source.version : null,
        });
        return full(v.toObject());
    } catch (e) {
        if (e.code === 11000) throw await dupDraft(type);
        throw e;
    }
};

/** from: 'published' (default) | 'blank' | 'version' (with a version number) */
exports.createDraft = async (rawType, { from = 'published', version, userId } = {}) => {
    const type = resolveType(rawType);
    await ensureDefaults();
    await promoteDue(type);
    if (from === 'blank') return makeDraft(type, { source: null, userId });
    if (from === 'version') {
        const src = await Version.findOne({ type, version }).lean();
        if (!src) throw new ApiError(404, 'Version not found');
        return makeDraft(type, { source: src, userId });
    }
    const src = await Version.findOne({ type, status: 'published' }).lean();
    return makeDraft(type, { source: src || null, userId });
};

exports.restore = async (rawType, version, userId) => {
    const type = resolveType(rawType);
    const src = await Version.findOne({ type, version }).lean();
    if (!src) throw new ApiError(404, 'Version not found');
    if (src.status === 'draft') throw new ApiError(400, 'That version is already a draft');
    return makeDraft(type, { source: src, userId });
};

exports.saveDraft = async (rawType, { title, contentHtml, revision, userId }) => {
    const type = resolveType(rawType);
    const set = { updatedBy: userId || null };
    if (title !== undefined) set.title = title.trim();
    if (contentHtml !== undefined) {
        const clean = html.clean(contentHtml);
        set.contentHtml = clean;
        set.contentText = html.toText(clean);
    }
    if (set.title !== undefined || set.contentHtml !== undefined) {
        const cur = await Version.findOne({ type, status: 'draft' }).select('title contentHtml').lean();
        if (!cur) throw new ApiError(404, 'There is no draft to save. Create one first.');
        set.checksum = html.checksum(set.title ?? cur.title, set.contentHtml ?? cur.contentHtml);
    }
    const v = await Version.findOneAndUpdate({ type, status: 'draft', revision }, { $set: set, $inc: { revision: 1 } }, { returnDocument: 'after' }).populate(POP).lean();
    if (!v) {
        if (!(await Version.exists({ type, status: 'draft' }))) throw new ApiError(404, 'There is no draft to save. Create one first.');
        throw fail(409, 'This draft was changed somewhere else. Reload it before saving.', { code: 'REVISION_CONFLICT' });
    }
    return full(v);
};

exports.deleteDraft = async (rawType) => {
    const type = resolveType(rawType);
    const v = await Version.findOneAndDelete({ type, status: 'draft' }).select(SUMMARY_FIELDS).lean();
    if (!v) throw new ApiError(404, 'There is no draft to delete');
    return summary(v);
};

/** Publishes the draft. A future effectiveFrom parks it as 'scheduled'; the public site switches over on that date. */
exports.publish = async (rawType, { revision, effectiveFrom, summaryOfChanges, userId }) => {
    const type = resolveType(rawType);
    await ensureDefaults();
    await promoteDue(type);
    const note = String(summaryOfChanges || '').trim();
    if (note.length < 3) throw new ApiError(400, 'Describe what changed');
    const now = Date.now();
    const eff = effectiveFrom ? new Date(effectiveFrom) : new Date(now);
    if (isNaN(eff.getTime())) throw new ApiError(400, 'Invalid effective date');
    if (eff.getTime() < now - PAST_SLACK_MS) throw new ApiError(400, 'The effective date cannot be in the past');
    if (eff.getTime() > now + FUTURE_LIMIT_MS) throw new ApiError(400, 'The effective date cannot be more than a year ahead');
    const effective = eff.getTime() <= now + 1000 ? new Date(now) : eff;

    const draft = await Version.findOne({ type, status: 'draft' }).lean();
    if (!draft) throw new ApiError(404, 'There is no draft to publish');
    if (draft.revision !== revision) throw fail(409, 'This draft was changed somewhere else. Reload it before publishing.', { code: 'REVISION_CONFLICT' });

    const live = await Version.findOne({ type, status: 'published' }).select('effectiveFrom version').lean();
    if (live && live.effectiveFrom && effective < live.effectiveFrom) throw new ApiError(400, "The effective date must not be earlier than the current version's");
    const waiting = await Version.findOne({ type, status: 'scheduled' }).select('version effectiveFrom').lean();
    if (waiting) throw fail(409, `Version ${waiting.version} is already scheduled. Cancel it first.`, { code: 'ALREADY_SCHEDULED' });

    // sanitise again on publish: nothing that was not clean at save time can ever go live
    const body = html.clean(draft.contentHtml);
    const text = html.toText(body);
    if (!draft.title || !draft.title.trim()) throw new ApiError(400, 'The title is empty');
    if (text.length < MIN_TEXT) throw new ApiError(400, 'The document is empty');

    let claimed;
    try {
        claimed = await Version.findOneAndUpdate(
            { _id: draft._id, status: 'draft', revision },
            { $set: { status: 'scheduled', contentHtml: body, contentText: text, checksum: html.checksum(draft.title, body), summaryOfChanges: note, effectiveFrom: effective, publishedAt: new Date(), publishedBy: userId || null, updatedBy: userId || null } },
            { returnDocument: 'after' },
        ).lean();
    } catch (e) {
        if (e.code === 11000) throw fail(409, 'Another version is already scheduled. Cancel it first.', { code: 'ALREADY_SCHEDULED' });
        throw e;
    }
    if (!claimed) throw fail(409, 'This draft was changed somewhere else. Reload it before publishing.', { code: 'REVISION_CONFLICT' });
    await promoteDue(type);
    const after = await Version.findById(claimed._id).select(SUMMARY_FIELDS).populate(POP).lean();
    return { ...summary(after), live: after.status === 'published' };
};

exports.cancelSchedule = async (rawType) => {
    const type = resolveType(rawType);
    if (await Version.exists({ type, status: 'draft' })) throw fail(409, 'Delete or publish the current draft first; the scheduled version would come back as a second draft.', { code: 'DRAFT_EXISTS' });
    const v = await Version.findOneAndUpdate(
        { type, status: 'scheduled', effectiveFrom: { $gt: new Date() } },
        { $set: { status: 'draft', effectiveFrom: null, publishedAt: null, publishedBy: null }, $inc: { revision: 1 } },
        { returnDocument: 'after' },
    ).select(SUMMARY_FIELDS).lean();
    if (!v) throw new ApiError(404, 'There is no scheduled version to cancel (or it has just gone live)');
    return summary(v);
};

// ---------------------------------------------------------------------------
// Public (no login): published text only
// ---------------------------------------------------------------------------
// the closest older version that was ever public (version numbers have gaps: deleted drafts keep their number)
const previousOf = async (v) => {
    const prev = await Version.findOne({ type: v.type, version: { $lt: v.version }, status: { $in: ['published', 'archived'] }, effectiveFrom: { $lte: new Date() } }).sort({ version: -1 }).select('version').lean();
    return prev ? prev.version : null;
};
const toPublic = async (v) => ({
    type: v.type, slug: SLUGS[v.type], title: v.title, version: v.version, label: `v${v.version}`,
    effectiveFrom: v.effectiveFrom, updatedAt: v.publishedAt || v.effectiveFrom,
    description: (v.contentText || '').slice(0, 200), contentHtml: v.contentHtml, checksum: v.checksum,
    previousVersion: await previousOf(v),
});

exports.getPublic = async (rawType) => {
    const type = resolveType(rawType);
    await ensureDefaults();
    await promoteDue(type);
    const v = await Version.findOne({ type, status: 'published' }).lean();
    if (!v) throw new ApiError(404, 'This document is not published yet');
    return await toPublic(v);
};

exports.getPublicVersion = async (rawType, version) => {
    const type = resolveType(rawType);
    await ensureDefaults();
    await promoteDue(type);
    const v = await Version.findOne({ type, version, status: { $in: ['published', 'archived'] }, effectiveFrom: { $lte: new Date() } }).lean();
    if (!v) throw new ApiError(404, 'Version not found');
    return await toPublic(v);
};

exports.listPublic = async () => {
    await ensureDefaults();
    await Promise.all(TYPES.map(promoteDue));
    const rows = await Version.find({ status: 'published' }).select(SUMMARY_FIELDS).lean();
    return TYPES.map((type) => {
        const v = rows.find((r) => r.type === type);
        return v ? { type, slug: SLUGS[type], title: v.title, version: v.version, label: `v${v.version}`, effectiveFrom: v.effectiveFrom, updatedAt: v.publishedAt || v.effectiveFrom, path: `/${SLUGS[type]}` } : null;
    }).filter(Boolean);
};

// ---------------------------------------------------------------------------
// Which versions a person agrees to (consent records)
// ---------------------------------------------------------------------------

/** { privacy: 3, terms: 2, refund: 1 } (null when a document has no published version). Never throws. */
exports.currentVersions = async () => {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    try {
        await ensureDefaults();
        const rows = await Version.find({ status: 'published', effectiveFrom: { $lte: new Date() } }).select('type version').lean();
        const get = (t) => rows.find((r) => r.type === t)?.version ?? null;
        const value = { privacy: get('privacy_policy'), terms: get('terms_and_conditions'), refund: get('refund_cancellation_policy') };
        cache = { at: Date.now(), value };
        return value;
    } catch (_) {
        return { privacy: null, terms: null, refund: null };
    }
};

/** String stored in a consent record. `fallback` keeps the old fixed version when the documents are not available. */
exports.consentVersion = async (fallback) => {
    const v = await exports.currentVersions();
    if (v.privacy == null && v.terms == null) return fallback;
    return `privacy-v${v.privacy ?? '?'};terms-v${v.terms ?? '?'}`;
};

exports.privacyVersionLabel = async (fallback) => {
    const v = await exports.currentVersions();
    return v.privacy == null ? fallback : `v${v.privacy}`;
};

exports.invalidateCache = invalidateCache;
exports.TYPES = TYPES;
exports.LABELS = LABELS;
exports.SLUGS = SLUGS;
exports.resolveType = resolveType;
exports.ensureDefaults = ensureDefaults;
exports.promoteDue = promoteDue;
