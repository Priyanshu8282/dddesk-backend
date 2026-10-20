const express = require('express');
const loc = require('../../data/indiaLocations');
const ApiError = require('../../utils/ApiError');

const router = express.Router();

// Static reference data: cache for an hour
router.use((req, res, next) => {
    res.set('Cache-Control', 'public, max-age=3600');
    next();
});

// GET /v1/public/locations/countries
router.get('/countries', (req, res) => {
    res.json({ success: true, data: loc.COUNTRIES });
});

// GET /v1/public/locations/states?country=IN
router.get('/states', (req, res, next) => {
    if (req.query.country && !loc.findCountry(req.query.country)) return next(new ApiError(404, 'Country not supported'));
    // Only India has a state list; other countries enter state and city as text
    const india = loc.isIndia(req.query.country);
    res.json({ success: true, data: india ? loc.stateNames() : [], hasList: india });
});

// GET /v1/public/locations/cities?state=Rajasthan
router.get('/cities', (req, res, next) => {
    const state = String(req.query.state || '');
    if (!state) return next(new ApiError(400, 'state is required'));
    const cities = loc.citiesOf(state);
    if (!cities) return next(new ApiError(404, 'State not found'));
    res.json({ success: true, data: cities });
});

module.exports = router;
