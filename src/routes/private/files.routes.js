const express = require('express');
const path = require('path');
const fs = require('fs');
const catchAsync = require('../../utils/catchAsync');
const ApiError = require('../../utils/ApiError');
const escapeRegex = require('../../utils/escapeRegex');
const Student = require('../../models/student.model');
const Admin = require('../../models/admin.model');
const { assertBranchAccess } = require('../../utils/branchScope');

const router = express.Router();

// Folders holding identity / personal documents. They are NOT served statically (see app.js);
// a file is released only to someone who may see the record that owns it.
const PROTECTED = ['documents', 'common'];
const NAME_RE = /^[A-Za-z0-9_.-]{1,200}$/;

const STAFF_STUDENT_PERMS = ['VIEW_STUDENTS', 'students.view'];
const STAFF_STAFF_PERMS = ['staff.view', 'VIEW_ADMINS'];
const hasAny = (req, keys) => keys.some((k) => (req.permissions || []).includes(k));

router.get('/:folder/:file', catchAsync(async (req, res) => {
    const { folder, file } = req.params;
    if (!PROTECTED.includes(folder) || !NAME_RE.test(file) || file.startsWith('.')) throw new ApiError(404, 'File not found');

    const rel = `uploads/${folder}/${file}`;
    const rx = new RegExp(`(^|/)${escapeRegex(rel)}$`);
    const scope = req.userType === 'superadmin' ? {} : { libraryId: req.libraryId };

    let allowed = false;
    const student = await Student.findOne({ ...scope, $or: [{ aadhaarCardImage: rx }, { 'documents.url': rx }] }).select('branchId').lean();
    if (student) {
        if (req.userType === 'student') allowed = String(student._id) === String(req.user._id);
        else if (req.userType === 'staff') {
            if (!hasAny(req, STAFF_STUDENT_PERMS)) throw new ApiError(403, 'You do not have permission to view this file');
            assertBranchAccess(req, student.branchId);
            allowed = true;
        } else allowed = true;
    } else if (req.userType !== 'student') {
        const admin = await Admin.findOne({ ...scope, isDeleted: { $ne: true }, 'documents.files': rx }).select('_id').lean();
        if (admin) {
            if (req.userType === 'staff' && String(admin._id) !== String(req.user._id) && !hasAny(req, STAFF_STAFF_PERMS)) {
                throw new ApiError(403, 'You do not have permission to view this file');
            }
            allowed = true;
        }
    }
    if (!allowed) throw new ApiError(404, 'File not found');

    const full = path.join(process.cwd(), 'uploads', folder, file);
    if (!fs.existsSync(full)) throw new ApiError(404, 'File not found');
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
        'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.sendFile(full, { dotfiles: 'deny' });
}));

module.exports = router;
