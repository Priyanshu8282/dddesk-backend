/**
 * Support tickets between libraries and the platform (spec 5.1).
 * Library side is always scoped by libraryId from the request; the super admin side sees all tickets.
 */
const mongoose = require('mongoose');
const SupportTicket = require('../models/supportTicket.model');
const Admin = require('../models/admin.model');
const Notification = require('../models/notification.model');
const ApiError = require('../utils/ApiError');
const escapeRegex = require('../utils/escapeRegex');
const audit = require('../utils/audit');

const clampPaging = (q = {}) => ({
    page: Math.max(1, parseInt(q.page, 10) || 1),
    limit: Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20))
});

const short = (s, n = 200) => (String(s).length > n ? `${String(s).slice(0, n - 1)}...` : String(s));

// ---- notifications -------------------------------------------------------
const notifySuperAdmins = async (ticket, event, title, message) => {
    try {
        let ids;
        if (ticket.assignedTo) ids = [ticket.assignedTo];
        else ids = (await Admin.find({ userType: 'superadmin', status: true, isDeleted: { $ne: true } }).select('_id').lean()).map((a) => a._id);
        if (!ids.length) return;
        await Notification.insertMany(ids.map((id) => ({
            recipientId: id, recipientType: 'Admin', type: 'support_alert', event, title, message,
            data: { ticketId: String(ticket._id), libraryId: String(ticket.libraryId) },
            deliveries: [{ channel: 'inapp', status: 'sent' }]
        })));
    } catch (e) { console.error('[support] notify super admins failed:', e.message); }
};

const notifyLibrary = async (ticket, event, variables) => {
    try {
        const { notifyEvent } = require('./notification.service');
        const owners = await Admin.find({ libraryId: ticket.libraryId, userType: 'admin', status: true, isDeleted: { $ne: true } }).select('_id').lean();
        const ids = [...new Set([String(ticket.createdBy), ...owners.map((o) => String(o._id))])];
        await notifyEvent(event, ticket.libraryId, {
            adminIds: ids, variables: { subject: ticket.subject, ...variables },
            data: { ticketId: String(ticket._id), event }, channels: ['inapp', 'push']
        });
    } catch (e) { console.error('[support] notify library failed:', e.message); }
};

// ---- library side --------------------------------------------------------
exports.createTicket = async (req) => {
    if (!req.libraryId) throw new ApiError(400, 'Library context is required');
    const { subject, message, category, priority } = req.body;
    const ticket = await SupportTicket.create({
        libraryId: req.libraryId, createdBy: req.user._id, subject, message, category, priority, lastReplyAt: new Date()
    });
    audit(req, 'support.ticket.create', 'SupportTicket', ticket._id, { subject, category, priority });
    await notifySuperAdmins(ticket, 'support-ticket-new', `New support ticket: ${short(subject, 80)}`,
        `${req.library ? req.library.name : 'A library'}: ${short(message)}`);
    return ticket;
};

exports.listOwn = async (libraryId, query = {}) => {
    const { page, limit } = clampPaging(query);
    const filter = { libraryId };
    if (query.status) filter.status = String(query.status);
    const [data, total] = await Promise.all([
        SupportTicket.find(filter).select('-replies').sort({ lastReplyAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        SupportTicket.countDocuments(filter)
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
};

exports.getOwn = async (id, libraryId) => {
    const t = await SupportTicket.findOne({ _id: id, libraryId })
        .populate('createdBy', 'name').populate('assignedTo', 'name').lean();
    if (!t) throw new ApiError(404, 'Ticket not found');
    return t;
};

const reply = (req, byType) => ({
    by: req.user._id, byType, byName: req.user.name, message: req.body.message, at: new Date()
});

exports.replyOwn = async (req) => {
    const { id } = req.params;
    const r = reply(req, 'library');
    const ticket = await SupportTicket.findOneAndUpdate(
        { _id: id, libraryId: req.libraryId, status: { $ne: 'closed' } },
        { $push: { replies: r }, $set: { lastReplyAt: r.at } },
        { new: true }
    );
    if (!ticket) {
        if (await SupportTicket.exists({ _id: id, libraryId: req.libraryId })) throw new ApiError(409, 'This ticket is closed. Open a new ticket instead');
        throw new ApiError(404, 'Ticket not found');
    }
    if (ticket.status === 'resolved') {
        const re = await SupportTicket.findOneAndUpdate({ _id: id, status: 'resolved' }, { $set: { status: 'open' }, $unset: { resolvedAt: '' } }, { new: true });
        if (re) ticket.status = 'open';
    }
    audit(req, 'support.ticket.reply', 'SupportTicket', ticket._id, {});
    await notifySuperAdmins(ticket, 'support-ticket-reply', `Ticket reply: ${short(ticket.subject, 80)}`, short(r.message));
    return ticket;
};

// ---- super admin side ----------------------------------------------------
exports.listAll = async (query = {}) => {
    const { page, limit } = clampPaging(query);
    const filter = {};
    for (const k of ['status', 'priority', 'category']) if (query[k]) filter[k] = String(query[k]);
    if (query.libraryId && mongoose.isValidObjectId(query.libraryId)) filter.libraryId = query.libraryId;
    if (query.assignedTo && mongoose.isValidObjectId(query.assignedTo)) filter.assignedTo = query.assignedTo;
    if (query.search) {
        const rx = new RegExp(escapeRegex(String(query.search)), 'i');
        filter.$or = [{ subject: rx }, { message: rx }];
    }
    const [data, total] = await Promise.all([
        SupportTicket.find(filter).select('-replies')
            .populate('libraryId', 'name libraryCode').populate('createdBy', 'name').populate('assignedTo', 'name')
            .sort({ lastReplyAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        SupportTicket.countDocuments(filter)
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
};

exports.getAny = async (id) => {
    const t = await SupportTicket.findById(id)
        .populate('libraryId', 'name libraryCode mobile email').populate('createdBy', 'name email mobile').populate('assignedTo', 'name').lean();
    if (!t) throw new ApiError(404, 'Ticket not found');
    return t;
};

exports.updateAny = async (req) => {
    const { id } = req.params;
    const { status, priority, assignedTo } = req.body;
    const $set = {};
    const $unset = {};
    if (priority) $set.priority = priority;
    if (assignedTo !== undefined) {
        if (assignedTo === null) $set.assignedTo = null;
        else {
            const sa = await Admin.findOne({ _id: assignedTo, userType: 'superadmin', status: true, isDeleted: { $ne: true } }).select('_id');
            if (!sa) throw new ApiError(400, 'assignedTo must be an active super admin');
            $set.assignedTo = sa._id;
        }
    }
    if (status) {
        $set.status = status;
        if (status === 'resolved') { $set.resolvedAt = new Date(); }
        else $unset.resolvedAt = '';
        if (status === 'closed') $set.closedAt = new Date();
        else $unset.closedAt = '';
    }
    const update = { $set };
    if (Object.keys($unset).length) update.$unset = $unset;
    const before = await SupportTicket.findOneAndUpdate({ _id: id }, update, { new: false });
    if (!before) throw new ApiError(404, 'Ticket not found');
    const ticket = await SupportTicket.findById(id);
    audit(req, 'support.ticket.update', 'SupportTicket', ticket._id, { libraryId: String(ticket.libraryId), from: before.status, to: ticket.status, assignedTo: ticket.assignedTo });
    if (status && status !== before.status) await notifyLibrary(ticket, 'support-ticket-update', { status: status.replace('_', ' ') });
    return ticket;
};

exports.replyAny = async (req) => {
    const { id } = req.params;
    const r = reply(req, 'support');
    const ticket = await SupportTicket.findOneAndUpdate(
        { _id: id, status: { $ne: 'closed' } },
        { $push: { replies: r }, $set: { lastReplyAt: r.at } },
        { new: true }
    );
    if (!ticket) {
        if (await SupportTicket.exists({ _id: id })) throw new ApiError(409, 'This ticket is closed');
        throw new ApiError(404, 'Ticket not found');
    }
    if (ticket.status === 'open') {
        const upd = await SupportTicket.findOneAndUpdate({ _id: id, status: 'open' }, { $set: { status: 'in_progress' } }, { new: true });
        if (upd) ticket.status = 'in_progress';
    }
    audit(req, 'support.ticket.reply', 'SupportTicket', ticket._id, { libraryId: String(ticket.libraryId), by: 'support' });
    await notifyLibrary(ticket, 'support-ticket-reply', { message: short(r.message) });
    return ticket;
};
