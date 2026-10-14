const express = require('express');
const seatController = require('../../controllers/seat.controller');
const validate = require('../../middlewares/validate.middleware');
const { seatValidation } = require('../../validations');

const router = express.Router();

router.get('/stats', seatController.getSeatStats);
router.get('/', seatController.getSeats);
router.post('/', validate(seatValidation.createSeat), seatController.createSeat);
router.post('/bulk', validate(seatValidation.bulkCreateSeats), seatController.bulkCreateSeats);
router.get('/:id', seatController.getSeatById);
router.put('/:id', seatController.updateSeat);
router.patch('/:id/assign', validate(seatValidation.assignSeat), seatController.assignSeat);
router.patch('/:id/release', seatController.releaseSeat);
router.delete('/:id', seatController.deleteSeat);

module.exports = router;
