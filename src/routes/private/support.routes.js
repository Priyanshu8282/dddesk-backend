const express = require('express');
const c = require('../../controllers/support.controller');
const validate = require('../../middlewares/validate.middleware');
const ApiError = require('../../utils/ApiError');
const { requireStaff, requirePermission, requireSuperAdmin } = require('../../middlewares/access.middleware');
const v = require('../../validations/support.validation');

// Library side: mounted at /support (owner, or staff holding support.manage / settings.manage). Own library only.
const library = express.Router();
library.use(requireStaff, requirePermission('support.manage', 'settings.manage'), (req, res, next) =>
    (req.libraryId ? next() : next(new ApiError(400, 'Library context is required'))));
library.post('/tickets', validate(v.createTicket), c.create);
library.get('/tickets', validate(v.listOwn), c.listOwn);
library.get('/tickets/:id', validate(v.idParam), c.getOwn);
library.post('/tickets/:id/reply', validate(v.reply), c.replyOwn);

// Super admin: mounted at /super/support
const superAdmin = express.Router();
superAdmin.use(requireSuperAdmin);
superAdmin.get('/tickets', validate(v.listAll), c.listAll);
superAdmin.get('/tickets/:id', validate(v.idParam), c.getAny);
superAdmin.patch('/tickets/:id', validate(v.update), c.updateAny);
superAdmin.post('/tickets/:id/reply', validate(v.reply), c.replyAny);

module.exports = { library, superAdmin };
