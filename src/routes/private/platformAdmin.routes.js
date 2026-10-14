const express = require('express');
const c = require('../../controllers/platformAdmin.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireSuperAdmin } = require('../../middlewares/access.middleware');
const v = require('../../validations/platformAdmin.validation');

// Any authenticated user: mounted at /announcements
const active = express.Router();
active.get('/active', c.activeAnnouncements);

// Super admin announcements CRUD: mounted at /super/announcements
const announcements = express.Router();
announcements.use(requireSuperAdmin);
announcements.get('/', validate(v.listAnnouncements), c.listAnnouncements);
announcements.post('/', validate(v.createAnnouncement), c.createAnnouncement);
announcements.get('/:id', validate(v.idParam), c.getAnnouncement);
announcements.put('/:id', validate(v.updateAnnouncement), c.updateAnnouncement);
announcements.patch('/:id', validate(v.updateAnnouncement), c.updateAnnouncement);
announcements.delete('/:id', validate(v.idParam), c.deleteAnnouncement);

// Notification providers: mounted at /super/notification-providers
const providers = express.Router();
providers.use(requireSuperAdmin);
providers.get('/', c.getProviders);
providers.put('/', validate(v.updateProviders), c.updateProviders);

// System events: mounted at /super/system-events
const systemEvents = express.Router();
systemEvents.use(requireSuperAdmin);
systemEvents.get('/', validate(v.systemEvents), c.systemEvents);

module.exports = { active, announcements, providers, systemEvents };
