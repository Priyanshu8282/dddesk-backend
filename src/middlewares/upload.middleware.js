const multer = require('multer');
const path = require('path');
const fs = require('fs');

const os = require('os');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        let subDir = 'uploads/';

        // Check if the request is for a vendor route (matches /vendors/self, /vendors/add-vendor, etc.)
        if (req.originalUrl && (req.originalUrl.includes('/vendor') || req.originalUrl.includes('/vendors'))) {
            subDir += 'vendor/';
            if (file.fieldname === 'profileImage') {
                subDir += 'profile/';
            } else {
                subDir += 'business/';
            }
        } else {
            // Default routing
            if (file.fieldname === 'profileImage') {
                subDir += 'profiles/';
            } else if (file.fieldname === 'media' || file.fieldname === 'storyMedia') {
                if (req.originalUrl && req.originalUrl.includes('/notices')) {
                    subDir += 'notices/';
                } else {
                    subDir += 'stories/';
                }
            } else {
                subDir += 'products/';
            }
        }

        // Try local process.cwd() path first
        let targetDir = path.join(process.cwd(), subDir);
        try {
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
            return cb(null, targetDir);
        } catch (err) {
            // Read-only filesystem (e.g. Vercel, AWS Lambda), fallback to OS temp directory (/tmp)
            targetDir = path.join(os.tmpdir(), subDir);
            try {
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                }
            } catch (e) {
                console.error("Failed to create temp upload directory:", e.message);
            }
            return cb(null, targetDir);
        }
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
        cb(null, true);
    } else {
        cb(new Error('Only images and videos are allowed'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

module.exports = upload;
