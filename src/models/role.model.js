const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },

    permissionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Permission" }],
    sidebarMenuIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "SidebarMenu" }], // New field for role-based sidebar

    isDefault: { type: Boolean, default: false },
    status: { type: Boolean, default: true },

    tenantId: { type: mongoose.Schema.Types.ObjectId }, // SaaS Ready

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

module.exports = mongoose.model('Role', roleSchema);
