const express = require('express');
const Authentication = require('../../middlewares/auth.middleware');
const seatController = require('./seat.controller');

const router = express.Router();
router.use(Authentication);

router.get('/stats', seatController.getSeatStats);
router.get('/', seatController.getSeats);
router.post('/', seatController.createSeat);
router.post('/bulk', seatController.bulkCreateSeats);
router.get('/:id', seatController.getSeatById);
router.put('/:id', seatController.updateSeat);
router.patch('/:id/assign', seatController.assignSeat);
router.patch('/:id/release', seatController.releaseSeat);
router.delete('/:id', seatController.deleteSeat);

module.exports = router;
