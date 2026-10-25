const mongoose = require('mongoose');

// draft      editable, at most one per type
// scheduled  approved and waiting for its effective date (immutable), at most one per type
// published  what the public site shows (immutable), exactly one per type
// archived   an older published version, kept forever for history (immutable)
const STATUSES = ['draft', 'scheduled', 'published', 'archived'];
const IMMUTABLE_FIELDS = ['type', 'version', 'title', 'contentHtml', 'contentText', 'checksum', 'createdBy', 'sourceVersion'];

const schema = new mongoose.Schema({
    type: { type: String, required: true, index: true },
    version: { type: Number, required: true, min: 1 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    contentHtml: { type: String, default: '' },     // sanitised on save and on publish
    contentText: { type: String, default: '' },                     // plain text for search and meta descriptions
    summaryOfChanges: { type: String, trim: true, maxlength: 1000, default: '' },
    status: { type: String, enum: STATUSES, default: 'draft', index: true },
    revision: { type: Number, default: 1 },                         // optimistic concurrency for draft edits
    effectiveFrom: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    sourceVersion: { type: Number, default: null },                 // version this draft was copied from
    checksum: { type: String, default: null },
}, { timestamps: true });

schema.index({ type: 1, version: 1 }, { unique: true });
// the invariants, enforced by the database
schema.index({ type: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'published' }, name: 'one_published_per_type' });
schema.index({ type: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'draft' }, name: 'one_draft_per_type' });
schema.index({ type: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'scheduled' }, name: 'one_scheduled_per_type' });

// Published, scheduled and archived text can never change: a correction is a new version.
schema.pre('save', function () {
    if (this.isNew) return;
    const bad = IMMUTABLE_FIELDS.filter((f) => this.isModified(f));
    // only a draft that stays a draft may change its text; every other save of changed text is refused
    if (bad.length && !(this.status === 'draft' && !this.isModified('status'))) {
        throw new Error(`Legal text is immutable once it leaves draft (${bad.join(', ')})`);
    }
});
const guard = function () {
    const q = this.getQuery();
    const u = this.getUpdate() || {};
    const touched = new Set();
    for (const k of Object.keys(u)) {
        if (k.startsWith('$')) Object.keys(u[k] || {}).forEach((f) => touched.add(f));
        else touched.add(k);
    }
    const bad = IMMUTABLE_FIELDS.filter((f) => touched.has(f));
    if (bad.length && q.status !== 'draft') throw new Error(`Legal text is immutable once it leaves draft (${bad.join(', ')})`);
};
schema.pre('findOneAndUpdate', guard);
schema.pre('updateOne', guard);
schema.pre('updateMany', guard);
schema.pre('findOneAndReplace', function () { throw new Error('Legal versions cannot be replaced'); });
schema.pre('replaceOne', function () { throw new Error('Legal versions cannot be replaced'); });

schema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.LegalDocumentVersion || mongoose.model('LegalDocumentVersion', schema);
