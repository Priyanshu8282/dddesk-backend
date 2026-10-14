const mongoose = require('mongoose');

// Roles are tenant scoped. libraryId = null marks a platform/system role (Super Admin, Admin, Staff templates).
const roleSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },

    libraryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Library', default: null, index: true },

    permissionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Permission" }],
    sidebarMenuIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "SidebarMenu" }], // New field for role-based sidebar

    isDefault: { type: Boolean, default: false }, // system role: only superadmin may modify
    status: { type: Boolean, default: true },

    tenantId: { type: mongoose.Schema.Types.ObjectId }, // legacy, unused

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }
}, {
    timestamps: true
});

// Name is unique within a tenant; system roles (libraryId null) are unique among themselves.
roleSchema.index({ libraryId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Role', roleSchema);
