const { z } = require('zod');

const seatType = z.enum(['standard', 'premium', 'window', 'ac', 'non-ac', 'custom']);
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const branchIdOpt = objectId.nullish();

const createSeat = z.object({
    body: z.object({
        seatNumber: z.string().trim().min(1, 'Seat number is required'),
        floor: z.string().optional().default('Ground Floor'),
        room: z.string().optional().default('Main Hall'),
        type: seatType.default('standard'),
        customType: z.string().optional(),
        price: z.coerce.number().min(0).optional().default(0),
        // 'occupied'/'reserved' need a student: use assign/reserve endpoints
        status: z.enum(['available', 'blocked', 'maintenance']).default('available'),
        blockedReason: z.string().optional(),
        branchId: branchIdOpt
    })
});

const updateSeat = z.object({
    body: z.object({
        seatNumber: z.string().trim().min(1).optional(),
        floor: z.string().optional(),
        room: z.string().optional(),
        type: seatType.optional(),
        customType: z.string().optional(),
        price: z.coerce.number().min(0).optional()
    })
});

const bulkCreateSeats = z.object({
    body: z.object({
        seats: z.array(z.object({
            seatNumber: z.string().trim().min(1, 'Seat number is required'),
            floor: z.string().optional().default('Ground Floor'),
            room: z.string().optional().default('Main Hall'),
            type: seatType.default('standard'),
            customType: z.string().optional(),
            price: z.coerce.number().min(0).optional().default(0),
            status: z.enum(['available', 'blocked', 'maintenance']).default('available')
        })).max(500).optional(),
        prefix: z.string().optional().default('S-'),
        startNumber: z.coerce.number().min(1).optional().default(1),
        count: z.coerce.number().min(1).max(500).optional(),
        floor: z.string().optional().default('Ground Floor'),
        room: z.string().optional().default('Main Hall'),
        type: seatType.optional().default('standard'),
        price: z.coerce.number().min(0).optional().default(0),
        branchId: branchIdOpt
    }).refine((data) => (Array.isArray(data.seats) && data.seats.length > 0) || (data.count && data.count > 0), {
        message: 'Either seats array or count must be provided',
        path: ['seats']
    })
});

const assignSeat = z.object({
    body: z.object({
        studentId: objectId
    })
});

const transferSeat = z.object({
    body: z.object({
        studentId: objectId,
        toSeatId: objectId,
        reason: z.string().max(300).optional()
    })
});

const reserveSeat = z.object({
    body: z.object({
        studentId: objectId,
        until: z.coerce.date(),
        reason: z.string().max(300).optional()
    })
});

const setSeatStatus = z.object({
    body: z.object({
        status: z.enum(['available', 'blocked', 'maintenance']),
        reason: z.string().max(300).optional()
    }).refine((d) => d.status === 'available' || (d.reason && d.reason.trim()), {
        message: 'A reason is required when blocking a seat or marking it for maintenance',
        path: ['reason']
    })
});

const listSeats = z.object({
    query: z.object({
        status: z.enum(['available', 'occupied', 'reserved', 'blocked', 'maintenance']).optional(),
        floor: z.string().optional(),
        room: z.string().optional(),
        type: seatType.optional(),
        branchId: objectId.optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional()
    }).passthrough()
});

const recoveryQuery = z.object({
    query: z.object({
        days: z.coerce.number().int().min(1).max(365).optional()
    }).passthrough()
});

module.exports = {
    createSeat,
    updateSeat,
    bulkCreateSeats,
    assignSeat,
    transferSeat,
    reserveSeat,
    setSeatStatus,
    listSeats,
    recoveryQuery
};
