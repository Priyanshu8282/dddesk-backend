const { z } = require('zod');

const createSeat = z.object({
    body: z.object({
        seatNumber: z.string().min(1, 'Seat number is required'),
        floor: z.string().optional().default('Ground Floor'),
        room: z.string().optional().default('Main Hall'),
        type: z.enum(['standard', 'premium', 'window', 'ac', 'non-ac', 'custom']).default('standard'),
        customType: z.string().optional(),
        price: z.coerce.number().optional().default(0),
        status: z.enum(['available', 'occupied', 'reserved', 'blocked', 'maintenance']).default('available')
    })
});

const bulkCreateSeats = z.object({
    body: z.object({
        seats: z.array(z.object({
            seatNumber: z.string().min(1, 'Seat number is required'),
            floor: z.string().optional().default('Ground Floor'),
            room: z.string().optional().default('Main Hall'),
            type: z.enum(['standard', 'premium', 'window', 'ac', 'non-ac', 'custom']).default('standard'),
            customType: z.string().optional(),
            price: z.coerce.number().optional().default(0),
            status: z.enum(['available', 'occupied', 'reserved', 'blocked', 'maintenance']).default('available')
        })).optional(),
        prefix: z.string().optional().default('S-'),
        startNumber: z.coerce.number().min(1).optional().default(1),
        count: z.coerce.number().min(1).max(500).optional(),
        floor: z.string().optional().default('Ground Floor'),
        room: z.string().optional().default('Main Hall'),
        type: z.enum(['standard', 'premium', 'window', 'ac', 'non-ac', 'custom']).optional().default('standard'),
        price: z.coerce.number().optional().default(0)
    }).refine((data) => (Array.isArray(data.seats) && data.seats.length > 0) || (data.count && data.count > 0), {
        message: 'Either seats array or count must be provided',
        path: ['seats']
    })
});

const assignSeat = z.object({
    body: z.object({
        studentId: z.string().min(1, 'Student ID is required')
    })
});

module.exports = {
    createSeat,
    bulkCreateSeats,
    assignSeat
};
