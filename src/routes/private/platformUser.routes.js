const express = require('express');
const { z } = require('zod');
const catchAsync = require('../../utils/catchAsync');
const validate = require('../../middlewares/validate.middleware');
const { requireSuperAdmin } = require('../../middlewares/access.middleware');
const svc = require('../../services/platformUser.service');

const router = express.Router();
router.use(requireSuperAdmin);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');
const idParam = z.object({ params: z.object({ id: objectId }) });
const type = z.enum(['all', 'owner', 'staff', 'superadmin', 'student']);
const mobile = z.string().trim().regex(/^(\+?91[\s-]?)?[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number');
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);

const listQuery = z.object({ query: z.object({
    type: type.optional(), status: z.enum(['all', 'active', 'disabled']).optional(), libraryId: objectId.optional(),
    q: z.string().trim().max(80).optional(), sort: z.enum(['newest', 'oldest', 'name_asc', 'name_desc', 'last_login']).optional(),
    page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
}) });
const getQuery = z.object({ params: z.object({ id: objectId }), query: z.object({ type: z.enum(['student', 'admin']).optional() }) });
const createBody = z.object({ body: z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().email(), mobile, password, confirmPassword: z.string().optional() })
    .refine((b) => b.confirmPassword === undefined || b.confirmPassword === b.password, { message: 'Passwords do not match', path: ['confirmPassword'] }) });
const updateBody = z.object({ params: z.object({ id: objectId }), body: z.object({ name: z.string().trim().min(2).max(100).optional(), email: z.string().trim().email().optional(), mobile: mobile.optional() }) });
const statusBody = z.object({ params: z.object({ id: objectId }), body: z.object({ active: z.boolean(), type: z.enum(['student', 'admin']).optional() }) });
const resetBody = z.object({ params: z.object({ id: objectId }), body: z.object({ newPassword: password, confirmPassword: z.string().optional() })
    .refine((b) => b.confirmPassword === undefined || b.confirmPassword === b.newPassword, { message: 'Passwords do not match', path: ['confirmPassword'] }) });

router.get('/', validate(listQuery), catchAsync(async (req, res) => {
    const r = await svc.list(req.query);
    res.json({ success: true, message: 'Users retrieved successfully', ...r });
}));
router.get('/library-options', catchAsync(async (req, res) => {
    res.json({ success: true, data: await svc.libraryOptions() });
}));
router.get('/:id', validate(getQuery), catchAsync(async (req, res) => {
    res.json({ success: true, message: 'User retrieved successfully', data: await svc.get(req.params.id, req.query.type) });
}));
router.post('/', validate(createBody), catchAsync(async (req, res) => {
    const data = await svc.create(req, req.body);
    res.status(201).json({ success: true, message: 'Super admin created successfully', data });
}));
router.put('/:id', validate(updateBody), catchAsync(async (req, res) => {
    res.json({ success: true, message: 'User updated', data: await svc.update(req, req.params.id, req.body) });
}));
router.patch('/:id/status', validate(statusBody), catchAsync(async (req, res) => {
    const data = await svc.setStatus(req, req.params.id, req.body);
    res.json({ success: true, message: req.body.active ? 'User enabled' : 'User disabled. Their sessions have ended.', data });
}));
router.post('/:id/reset-password', validate(resetBody), catchAsync(async (req, res) => {
    await svc.resetPassword(req, req.params.id, req.body.newPassword);
    res.json({ success: true, message: 'Password reset. The user has been signed out everywhere.' });
}));
router.delete('/:id', validate(idParam), catchAsync(async (req, res) => {
    await svc.archive(req, req.params.id);
    res.json({ success: true, message: 'User deleted' });
}));

module.exports = router;
