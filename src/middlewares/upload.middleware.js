const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        let dest = 'uploads/';

        // Check if the request is for a vendor route (matches /vendors/self, /vendors/add-vendor, etc.)
        if (req.originalUrl && (req.originalUrl.includes('/vendor') || req.originalUrl.includes('/vendors'))) {
            dest += 'vendor/';
            if (file.fieldname === 'profileImage') {
                dest += 'profile/';
            } else {
                dest += 'business/';
            }
        } else {
            // Default routing
            if (file.fieldname === 'profileImage') {
                dest += 'profiles/';
            } else if (file.fieldname === 'media' || file.fieldname === 'storyMedia') {
                if (req.originalUrl && req.originalUrl.includes('/notices')) {
                    dest += 'notices/';
                } else {
                    dest += 'stories/';
                }
            } else {
                dest += 'products/';
            }
        }

        // Ensure directory exists before saving
        if (!fs.existsSync(dest)) {
            try {
                fs.mkdirSync(dest, { recursive: true });
            } catch (err) {
                console.warn(`Could not create directory ${dest}:`, err.message);
            }
        }

        cb(null, dest);
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
