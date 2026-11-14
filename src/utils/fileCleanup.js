const fs = require('fs');
const path = require('path');
const os = require('os');

// Only ever delete inside the uploads folder or the OS temp dir (where uploads fall back to on a
// read-only filesystem) - never follow a stored path outside those roots.
const ROOTS = [path.resolve(process.cwd(), 'uploads'), path.resolve(os.tmpdir())];
const isInUploadRoot = (abs) => ROOTS.some((r) => abs === r || abs.startsWith(r + path.sep));

/** Delete one previously-uploaded file (best-effort; a missing file or one outside uploads/ is not an error). */
const removeUploadedFile = async (p) => {
    if (!p || typeof p !== 'string') return false;
    const abs = path.resolve(path.isAbsolute(p) ? p : path.join(process.cwd(), p));
    if (!isInUploadRoot(abs)) return false;
    try {
        await fs.promises.unlink(abs);
        return true;
    } catch (e) {
        return false;
    }
};

/** Delete several previously-uploaded files (best-effort, in parallel). Returns how many were actually removed. */
const removeUploadedFiles = async (paths) => {
    const list = [].concat(paths || []).filter(Boolean);
    const results = await Promise.all(list.map((p) => removeUploadedFile(p)));
    return results.filter(Boolean).length;
};

module.exports = { removeUploadedFile, removeUploadedFiles };
