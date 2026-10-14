const express = require('express');
const seatController = require('../../controllers/seat.controller');
const validate = require('../../middlewares/validate.middleware');
const { requireStaff, requirePermission } = require('../../middlewares/access.middleware');
const { seatValidation } = require('../../validations');

const router = express.Router();

// Seat management is staff/owner only: students must never reach these routes.
// Permission keys come from the catalog (spec 12: view, assign, transfer, block).
const VIEW = ['seats.view', 'seats.manage', 'seats.assign', 'seats.transfer', 'seats.block'];
const MANAGE = ['seats.manage'];
const ASSIGN = ['seats.assign', 'seats.manage'];
const TRANSFER = ['seats.transfer', 'seats.manage'];
const BLOCK = ['seats.block', 'seats.manage'];

router.use(requireStaff);

router.get('/stats', requirePermission(...VIEW), seatController.getSeatStats);
router.get('/layout', requirePermission(...VIEW), seatController.getLayout);
router.get('/recovery', requirePermission(...VIEW), validate(seatValidation.recoveryQuery), seatController.getRecovery);
router.get('/', requirePermission(...VIEW), validate(seatValidation.listSeats), seatController.getSeats);
router.post('/', requirePermission(...MANAGE), validate(seatValidation.createSeat), seatController.createSeat);
router.post('/bulk', requirePermission(...MANAGE), validate(seatValidation.bulkCreateSeats), seatController.bulkCreateSeats);
router.post('/transfer', requirePermission(...TRANSFER), validate(seatValidation.transferSeat), seatController.transferSeat);

router.get('/:id', requirePermission(...VIEW), seatController.getSeatById);
router.get('/:id/history', requirePermission(...VIEW), seatController.getSeatHistory);
router.put('/:id', requirePermission(...MANAGE), validate(seatValidation.updateSeat), seatController.updateSeat);
router.patch('/:id/assign', requirePermission(...ASSIGN), validate(seatValidation.assignSeat), seatController.assignSeat);
router.patch('/:id/release', requirePermission(...ASSIGN), seatController.releaseSeat);
router.post('/:id/reserve', requirePermission(...BLOCK), validate(seatValidation.reserveSeat), seatController.reserveSeat);
router.patch('/:id/status', requirePermission(...BLOCK), validate(seatValidation.setSeatStatus), seatController.setSeatStatus);
router.delete('/:id', requirePermission(...MANAGE), seatController.deleteSeat);

module.exports = router;
