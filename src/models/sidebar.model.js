const mongoose = require('mongoose');

const SubmenuSchema = new mongoose.Schema({
    title: { type: String, required: true },
    to: { type: String },
    update: { type: String },
}, { _id: false });

const sidebarMenuSchema = new mongoose.Schema({
    title: { type: String, required: true },
    iconStyle: { type: String },
    to: { type: String },
    parent_module_id: { type: String, default: "-1" },
    module_menu_priority: { type: String },
    module_id: { type: String },
    module_priority: { type: String },
    classChange: { type: String },
    classsChange: { type: String },
    extraClass: { type: String },
    extraclass: { type: String },
    hasMenu: { type: Boolean, default: false },
    userType: { type: String, enum: ['admin', 'library', 'staff', 'superadmin', 'student'], default: 'admin' },
    content: [SubmenuSchema]
}, {
    timestamps: true
});

module.exports = mongoose.model('SidebarMenu', sidebarMenuSchema);
