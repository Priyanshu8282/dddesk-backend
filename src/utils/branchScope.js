const mongoose = require('mongoose');
const ApiError = require('./ApiError');

/*
 * Multi-branch scoping helpers.
 *
 * - Owners (admin) and superadmin see every branch. They may narrow with ?branchId=.
 * - Staff whose Admin.branchIds is NON-EMPTY are limited to those branches.
 * - Staff whose Admin.branchIds is EMPTY have access to ALL branches of the library
 *   (documented behaviour: "empty = all branches").
 * - Students are never branch-filtered here (they are scoped by their own _id elsewhere).
 * - A library with no branches simply has branchId = null everywhere; with no
 *   ?branchId= and unrestricted user, the filter is {} so nothing changes.
 */

const isValidId = (v) => !!v && mongoose.Types.ObjectId.isValid(String(v)) && String(new mongoose.Types.ObjectId(String(v))) === String(v);
const toOid = (v) => new mongoose.Types.ObjectId(String(v));

// Branch ids the user is limited to, or null when unrestricted.
const allowedBranchIds = (req) => {
    if (req.userType !== 'staff') return null;
    const ids = (req.user && req.user.branchIds) || [];
    if (!ids.length) return null;
    return ids.map((b) => String(b && b._id ? b._id : b));
};

// Requested branch from the query (?branchId=), validated or null.
const requestedBranch = (req) => {
    const raw = req.query && req.query.branchId;
    if (!raw || raw === 'all') return null;
    if (!isValidId(raw)) throw new ApiError(400, 'Invalid branchId');
    return String(raw);
};

/**
 * Mongo filter fragment for branch scoping, e.g. { branchId: {$in:[..]} } or {}.
 * @param {object} req express request
 * @param {string} [field='branchId'] field name on the target model
 */
const branchFilter = (req, field = 'branchId') => {
    if (req.userType === 'student') return {};
    const allowed = allowedBranchIds(req);
    const wanted = requestedBranch(req);
    if (allowed) {
        if (wanted) {
            if (!allowed.includes(wanted)) throw new ApiError(403, 'You do not have access to this branch');
            return { [field]: toOid(wanted) };
        }
        return { [field]: { $in: allowed.map(toOid) } };
    }
    if (wanted) return { [field]: toOid(wanted) };
    return {};
};

// Throws 403 when a branch-limited staff touches a branch outside their list.
// Records with no branch (null) are only reachable by unrestricted users.
const assertBranchAccess = (req, branchId) => {
    const allowed = allowedBranchIds(req);
    if (!allowed) return true;
    if (!branchId || !allowed.includes(String(branchId._id || branchId))) {
        throw new ApiError(403, 'You do not have access to this branch');
    }
    return true;
};

// Validates that branchId is a live branch of the library; returns its ObjectId (or null if not provided).
const resolveBranch = async (libraryId, branchId, { required = false } = {}) => {
    if (!branchId) {
        if (required) throw new ApiError(400, 'branchId is required');
        return null;
    }
    if (!isValidId(branchId)) throw new ApiError(400, 'Invalid branchId');
    const Branch = require('../models/branch.model');
    const b = await Branch.findOne({ _id: branchId, libraryId, isDeleted: false }).select('_id isActive').lean();
    if (!b) throw new ApiError(400, 'Branch not found in this library');
    return b._id;
};

// Branch to stamp on a new record created by the request user: explicit (validated) or,
// for a staff limited to exactly one branch, that branch.
const branchForCreate = async (req, libraryId, explicit) => {
    const id = await resolveBranch(libraryId, explicit);
    const allowed = allowedBranchIds(req);
    if (id) { assertBranchAccess(req, id); return id; }
    if (allowed && allowed.length === 1) return toOid(allowed[0]);
    if (allowed) throw new ApiError(400, 'branchId is required for branch-limited staff');
    return null;
};

// router.param('id', paramGuard(Model)): branch-limited staff can only reach records of their branches
const paramGuard = (Model) => async (req, res, next, id) => {
    try {
        if (req.userType === 'staff' && allowedBranchIds(req) && isValidId(id)) {
            const doc = await Model.findOne({ _id: id, libraryId: req.libraryId }).select('branchId').lean();
            if (doc) assertBranchAccess(req, doc.branchId);
        }
        next();
    } catch (e) { next(e); }
};

// Mongo condition for content that is either for every branch (branchId null/missing) or for `branchId`.
// branchId falsy = only all-branch content.
const branchVisibility = (branchId, field = 'branchId') => ({
    $or: [{ [field]: null }, ...(branchId ? [{ [field]: branchId._id || branchId }] : [])]
});

module.exports = { branchVisibility, paramGuard, branchFilter, assertBranchAccess, resolveBranch, branchForCreate, allowedBranchIds, isValidId };
