const express = require('express');
const catchAsync = require('../../utils/catchAsync');
const settings = require('../../services/platformSettings.service');

const router = express.Router();

// GET /v1/public/branding : name, logo, favicon, colours, support contact, maintenance + registration state.
// No login needed: the sign-in page, browser tab and maintenance screen use it.
router.get('/', catchAsync(async (req, res) => {
    res.set('Cache-Control', 'no-cache'); // always revalidate: a removed logo or favicon must disappear at once
    res.json({ success: true, data: await settings.publicBranding(req) });
}));

module.exports = router;
