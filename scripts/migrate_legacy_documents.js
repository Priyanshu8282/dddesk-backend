/*
 * Moves personal documents (student Aadhaar images / ID proofs, staff documents) that older versions saved in
 * uploads/common/ into uploads/documents/, and rewrites the paths stored in the database.
 *
 * Why: uploads/documents/ is never served publicly (only through the authenticated /v1/private/files route), but
 * uploads/common/ is still served statically because it also holds ordinary images. Files that belong to a
 * student or staff record must not stay there.
 *
 * Only files that are referenced by a student/staff document field are touched; other files in common/ stay.
 * Idempotent: a path already under uploads/documents/ is left alone, so running it twice is safe.
 *
 * Usage (from backend/):
 *   node scripts/migrate_legacy_documents.js           # DRY RUN: only prints what would change
 *   node scripts/migrate_legacy_documents.js --apply   # moves files + updates the database
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();
const config = require('../src/config/config');
const Student = require('../src/models/student.model');
const Admin = require('../src/models/admin.model');

const APPLY = process.argv.includes('--apply');
const UPLOADS = path.resolve(process.cwd(), 'uploads');
const COMMON_RE = /(^|[\\/])uploads[\\/]common[\\/]([A-Za-z0-9_.-]{1,200})$/;

const stats = { referenced: 0, moved: 0, missingFile: 0, dbUpdates: 0 };

/** Returns the new stored path for a legacy value, moving the file when --apply is given. null = nothing to do. */
const migratePath = (value) => {
    const m = COMMON_RE.exec(String(value || ''));
    if (!m) return null;
    stats.referenced++;
    const name = m[2];
    if (name.startsWith('.')) return null;
    const from = path.join(UPLOADS, 'common', name);
    const to = path.join(UPLOADS, 'documents', name);
    if (!from.startsWith(UPLOADS + path.sep) || !to.startsWith(UPLOADS + path.sep)) return null; // path traversal guard
    const next = String(value).replace(COMMON_RE, (all, pre) => `${pre}uploads/documents/${name}`);
    if (!fs.existsSync(from)) {
        stats.missingFile++;
        console.log(`  ! file not found, database path only: ${value}`);
        return next;
    }
    if (APPLY) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (fs.existsSync(to)) throw new Error(`Refusing to overwrite existing ${to}`);
        try { fs.renameSync(from, to); } catch (_) { fs.copyFileSync(from, to); fs.unlinkSync(from); } // rename fails across drives
    }
    stats.moved++;
    console.log(`  ${APPLY ? 'moved' : 'would move'}: common/${name} -> documents/${name}`);
    return next;
};

(async () => {
    console.log(APPLY ? 'APPLY mode: files will be moved and the database updated.\n' : 'DRY RUN: nothing is changed. Add --apply to write.\n');
    await mongoose.connect(config.mongoose.url);

    for await (const s of Student.find({ $or: [{ aadhaarCardImage: COMMON_RE }, { 'documents.url': COMMON_RE }] }).setOptions({ includeDeleted: true })) {
        const set = {};
        const a = migratePath(s.aadhaarCardImage);
        if (a) set.aadhaarCardImage = a;
        (s.documents || []).forEach((d, i) => { const n = migratePath(d.url); if (n) set[`documents.${i}.url`] = n; });
        if (Object.keys(set).length) {
            stats.dbUpdates++;
            if (APPLY) await Student.collection.updateOne({ _id: s._id }, { $set: set });
        }
    }

    for await (const a of Admin.find({ 'documents.files': COMMON_RE })) {
        const set = {};
        (a.documents || []).forEach((d, i) => (d.files || []).forEach((f, j) => { const n = migratePath(f); if (n) set[`documents.${i}.files.${j}`] = n; }));
        if (Object.keys(set).length) {
            stats.dbUpdates++;
            if (APPLY) await Admin.collection.updateOne({ _id: a._id }, { $set: set });
        }
    }

    console.log('\nSummary:', stats);
    await mongoose.disconnect();
})().catch(async (e) => {
    console.error('Failed:', e.message);
    try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
    process.exit(1);
});
