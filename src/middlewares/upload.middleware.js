const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ApiError = require('../utils/ApiError');

const MB = 1024 * 1024;

// Allowed types, identified by file CONTENT (magic bytes), never by client name/extension.
// svg / html / js and anything else are rejected.
const TYPES = {
    jpeg: { ext: '.jpg', mime: 'image/jpeg', kind: 'image' },
    png: { ext: '.png', mime: 'image/png', kind: 'image' },
    webp: { ext: '.webp', mime: 'image/webp', kind: 'image' },
    gif: { ext: '.gif', mime: 'image/gif', kind: 'image' },
    mp4: { ext: '.mp4', mime: 'video/mp4', kind: 'video' },
    webm: { ext: '.webm', mime: 'video/webm', kind: 'video' },
    pdf: { ext: '.pdf', mime: 'application/pdf', kind: 'pdf' }
};
const SIZE_LIMITS = { image: 5 * MB, video: 25 * MB, pdf: 10 * MB };
const ALLOWED_MIMES = new Set(Object.values(TYPES).map((t) => t.mime));
// Client-declared extensions that are explicitly refused (they could execute in a browser)
const BLOCKED_EXT = new Set(['.svg', '.svgz', '.html', '.htm', '.xhtml', '.js', '.mjs', '.php', '.exe', '.sh', '.bat', '.xml']);

const detectType = (buf) => {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return TYPES.jpeg;
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return TYPES.png;
    const head6 = buf.slice(0, 6).toString('latin1');
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return TYPES.gif;
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return TYPES.webp;
    if (buf.slice(4, 8).toString('latin1') === 'ftyp') return TYPES.mp4;
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return TYPES.webm;
    if (buf.slice(0, 5).toString('latin1') === '%PDF-') return TYPES.pdf;
    return null;
};

const readHead = (filePath, bytes = 32) => {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(bytes);
        const n = fs.readSync(fd, buf, 0, bytes, 0);
        return buf.slice(0, n);
    } finally {
        fs.closeSync(fd);
    }
};

/**
 * Resolve target sub-directory based on route and field name
 */
const getTargetDirectory = (req, file, cb) => {
    let subDir = 'uploads/';
    const url = req.originalUrl || '';

    if (url.includes('/vendor')) {
        subDir += 'vendor/';
        subDir += file.fieldname === 'profileImage' ? 'profile/' : 'business/';
    } else if (file.fieldname === 'profileImage') {
        subDir += 'profiles/';
    } else if (file.fieldname === 'platformLogo' || file.fieldname === 'platformFavicon') {
        subDir += 'branding/';
    } else if (file.fieldname === 'logo') {
        subDir += 'logos/';
    } else if (file.fieldname === 'photos') {
        subDir += 'photos/';
    } else if (file.fieldname === 'aadhaarCardImage') {
        subDir += 'documents/';
    } else if (['media', 'storyMedia', 'images', 'image'].includes(file.fieldname)) {
        if (url.includes('/notices')) subDir += 'notices/';
        else if (url.includes('/complaints')) subDir += 'complaints/';
        else if (url.includes('/banners')) subDir += 'banners/';
        else subDir += 'stories/';
    } else {
        subDir += 'common/';
    }

    let targetDir = path.join(process.cwd(), subDir);
    try {
        fs.mkdirSync(targetDir, { recursive: true });
        return cb(null, targetDir);
    } catch (err) {
        // Read-only filesystem fallback to OS temp directory
        targetDir = path.join(os.tmpdir(), subDir);
        try {
            fs.mkdirSync(targetDir, { recursive: true });
        } catch (e) {
            console.error('Failed to create upload directory:', e.message);
        }
        return cb(null, targetDir);
    }
};

/**
 * Disk storage that:
 *  - streams the upload to a temp file,
 *  - identifies the real type from the first bytes (client mimetype/extension are ignored),
 *  - enforces per-type size limits (image 5MB, video 25MB, pdf 10MB),
 *  - stores it under a random, unguessable name with the extension of the DETECTED type.
 */
class SecureDiskStorage {
    _handleFile(req, file, cb) {
        getTargetDirectory(req, file, (dirErr, targetDir) => {
            if (dirErr) return cb(dirErr);

            const tempFilePath = path.join(targetDir, `tmp_${crypto.randomBytes(12).toString('hex')}`);
            const out = fs.createWriteStream(tempFilePath);
            let failed = false;

            const fail = (err) => {
                if (failed) return;
                failed = true;
                out.destroy();
                fs.unlink(tempFilePath, () => {});
                cb(err);
            };

            file.stream.on('error', fail);
            file.stream.on('limit', () => fail(new ApiError(400, 'File is too large')));
            out.on('error', fail);
            file.stream.pipe(out);

            out.on('finish', () => {
                if (failed) return;
                let type;
                try {
                    type = detectType(readHead(tempFilePath));
                } catch (e) {
                    return fail(e);
                }
                if (!type) return fail(new ApiError(400, 'Unsupported or corrupted file. Allowed: JPG, PNG, WEBP, GIF, MP4, WEBM, PDF'));
                if (out.bytesWritten > SIZE_LIMITS[type.kind]) {
                    return fail(new ApiError(400, `${type.kind === 'image' ? 'Images' : type.kind === 'video' ? 'Videos' : 'PDFs'} must be ${SIZE_LIMITS[type.kind] / MB}MB or smaller`));
                }

                const prefix = (file.fieldname || 'file').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30) || 'file';
                const finalName = `${prefix}_${crypto.randomBytes(16).toString('hex')}${type.ext}`;
                const finalPath = path.join(targetDir, finalName);

                fs.rename(tempFilePath, finalPath, (renameErr) => {
                    if (renameErr) return fail(renameErr);
                    cb(null, {
                        destination: targetDir,
                        filename: finalName,
                        // Standardized web-friendly relative path (forward slashes)
                        path: path.relative(process.cwd(), finalPath).replace(/\\/g, '/'),
                        size: out.bytesWritten,
                        mimetype: type.mime,
                        mediaKind: type.kind
                    });
                });
            });
        });
    }

    _removeFile(req, file, cb) {
        const fullPath = path.isAbsolute(file.path) ? file.path : path.join(process.cwd(), file.path);
        fs.unlink(fullPath, cb);
    }
}

// First gate on the declared mimetype / extension; the real check is the magic-byte test above.
const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (BLOCKED_EXT.has(ext) || !ALLOWED_MIMES.has(String(file.mimetype).toLowerCase())) {
        return cb(new ApiError(400, 'Unsupported file type. Allowed: JPG, PNG, WEBP, GIF, MP4, WEBM, PDF'), false);
    }
    cb(null, true);
};

const base = multer({
    storage: new SecureDiskStorage(),
    fileFilter,
    limits: { fileSize: SIZE_LIMITS.video, files: 10 } // hard ceiling; per-type limits enforced in storage
});

// Convert multer's own errors into clean 400s for the shared error handler
const wrap = (middleware) => (req, res, next) =>
    middleware(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large'
                : err.code === 'LIMIT_UNEXPECTED_FILE' ? `Unexpected file field: ${err.field}`
                : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files'
                : err.message;
            return next(new ApiError(400, msg));
        }
        return next(err);
    });

const upload = {
    single: (name) => wrap(base.single(name)),
    array: (name, max) => wrap(base.array(name, max)),
    fields: (fields) => wrap(base.fields(fields)),
    any: () => wrap(base.any()),
    none: () => wrap(base.none())
};

/**
 * Error-path helper: once the response finishes with status >= 400, delete files multer already
 * stored for this request (req.file / req.files array or fields map) so rejected requests leave no orphans.
 */
const cleanupUploadsOnError = (req, res) => {
    if (!req || !res || res.__uploadCleanup) return;
    res.__uploadCleanup = true;
    res.once('finish', () => {
        if (res.statusCode < 400) return;
        const files = [];
        if (req.file) files.push(req.file);
        if (Array.isArray(req.files)) files.push(...req.files);
        else if (req.files && typeof req.files === 'object') Object.values(req.files).forEach((a) => files.push(...[].concat(a)));
        files.forEach((f) => {
            if (!f || !f.path) return;
            const full = path.isAbsolute(f.path) ? f.path : path.join(process.cwd(), f.path);
            fs.unlink(full, () => {});
        });
    });
};

module.exports = upload;
module.exports.detectType = detectType;
module.exports.cleanupUploadsOnError = cleanupUploadsOnError;
