require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/admin.model');
const Role = require('../models/role.model');
const SidebarMenu = require('../models/sidebar.model');
const config = require('../config/config');
const { syncRBAC } = require('./rbacSync');
const { syncLibrarySidebar } = require('./librarySidebar');

// Idempotent master seed. It never deletes permissions, menus, roles or accounts:
//  1. base sidebar menus are upserted (matched by title + parent + userType)
//  2. operational menus (sidebarSeed) are upserted
//  3. the permission catalog and system roles (Super Admin, Admin, Staff, Receptionist, Accountant, Manager) are synced
//  4. the platform Super Admin account is created if no superadmin exists (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD)

const sidebarData = [
    { "title": "Dashboard", "iconStyle": "<i className='la la-home' />", "parent_module_id": "1", "module_menu_priority": "1", "to": "dashboard" },
    { "title": "Database", "iconStyle": "<i className='la la-database' />", "parent_module_id": "1", "module_menu_priority": "2", "to": "database" },

    { "title": "Main Menu", "module_id": "1", "module_priority": "1", "classChange": "menu-title" },

    { "title": "Library Management", "classChange": "menu-title", "module_id": "12", "module_priority": "2", "userType": "admin" },
    {
        "title": "Libraries", "classsChange": "mm-collapse", "iconStyle": "<i className='la la-university' />", "parent_module_id": "12", "module_menu_priority": "1", "userType": "admin",
        "content": [
            { "title": "Add Library", "to": "libraries/add-library" },
            { "title": "Library List", "to": "libraries/list-libraries" }
        ]
    },

    { "title": "Student Management", "classChange": "menu-title", "module_id": "13", "module_priority": "3" },
    {
        "title": "Students", "classsChange": "mm-collapse", "iconStyle": "<i className='la la-user-graduate' />", "parent_module_id": "13", "module_menu_priority": "1",
        "content": [
            { "title": "Add Student", "to": "students/add-student" },
            { "title": "Student List", "to": "students/list-students" }
        ]
    },
    { "title": "Plan Management", "classChange": "menu-title", "module_id": "16", "module_priority": "4" },
    {
        "title": "Plans", "classsChange": "mm-collapse", "iconStyle": "<i className='la la-tags' />", "parent_module_id": "16", "module_menu_priority": "1",
        "content": [
            { "title": "Add Plan", "to": "plans/add-plan" },
            { "title": "Plan List", "to": "plans/list-plans" }
        ]
    },

    { "title": "Employee Management", "classChange": "menu-title", "module_id": "14", "module_priority": "5", "userType": "admin" },
    {
        "title": "Employees", "classsChange": "mm-collapse", "iconStyle": "<i className='la la-users' />", "parent_module_id": "14", "module_menu_priority": "1", "userType": "admin",
        "content": [
            { "title": "Add New Employee", "to": "admins/create-admin" },
            { "title": "Employee List", "to": "admins/get-admins" }
        ]
    },

    { "title": "Access Control", "classChange": "menu-title", "module_id": "15", "module_priority": "6", "userType": "admin" },
    {
        "title": "Role Management", "classsChange": "mm-collapse", "iconStyle": "<i className='la la-shield' />", "parent_module_id": "15", "module_menu_priority": "1", "userType": "admin",
        "content": [
            { "title": "Create Role", "to": "roles/create-role" },
            { "title": "Role List", "to": "roles/get-roles" }
        ]
    },

    { "title": "Transaction Management", "classChange": "menu-title", "module_id": "17", "module_priority": "7", "userType": "admin" },
    { "title": "Transactions", "iconStyle": "<i className='la la-file-invoice' />", "parent_module_id": "17", "module_menu_priority": "1", "userType": "admin", "to": "payments/list-payments" },

    { "title": "Permission Management", "classChange": "menu-title", "module_id": "18", "module_priority": "8", "userType": "admin" },
    { "title": "Permissions", "iconStyle": "<i className='la la-lock' />", "parent_module_id": "18", "module_menu_priority": "1", "userType": "admin", "to": "permissions/get-permissions" },

    // Student Menus
    { "title": "Student Portal", "classChange": "menu-title", "module_id": "20", "module_priority": "1", "userType": "student" },
    { "title": "My Dashboard", "iconStyle": "<i className='la la-home' />", "parent_module_id": "20", "module_menu_priority": "1", "userType": "student", "to": "dashboard" },
    { "title": "My Profile", "iconStyle": "<i className='la la-user-circle' />", "parent_module_id": "20", "module_menu_priority": "2", "userType": "student", "to": "profile" }
];

const masterSeed = async () => {
    try {
        await mongoose.connect(config.mongoose.url);
        console.log('Connected to MongoDB for master seeding');

        // library sidebar: one ordered list of pages that exist (anything else admin-side is removed)
        const sb = await syncLibrarySidebar({ apply: true });
        for (const m of sidebarData.filter((x) => x.userType === 'student')) {
            await SidebarMenu.updateOne({ title: m.title, parent_module_id: m.parent_module_id || '-1', userType: 'student' }, { $setOnInsert: m }, { upsert: true });
        }
        console.log(`Library sidebar synced (${sb.keep} kept, ${sb.create} created, ${sb.remove.length} removed).`);

        const rbac = await syncRBAC();
        console.log(`RBAC synced: ${rbac.permissions} permissions, ${rbac.menus} menus.`);

        const superRole = await Role.findOne({ name: 'Super Admin', libraryId: null });
        const existing = await Admin.findOne({ userType: 'superadmin' });
        if (!existing) {
            const email = (process.env.SEED_ADMIN_EMAIL || 'admin@mgibasket.com').toLowerCase();
            const password = process.env.SEED_ADMIN_PASSWORD;
            if (!password && process.env.NODE_ENV === 'production') throw new Error('Set SEED_ADMIN_PASSWORD to create the first super admin in production');
            await Admin.create({
                name: 'Super Admin', email, password: password || 'admin123', // hashed once by the Admin pre-save hook
                userType: 'superadmin', roleId: superRole._id, mobile: '1234567890', status: true,
            });
            console.log(`Super Admin created: ${email}${password ? '' : ' (default dev password - change it)'}`);
        } else {
            console.log('A super admin already exists; account left untouched.');
        }
        process.exit(0);
    } catch (error) {
        console.error('Master seeding failed:', error);
        process.exit(1);
    }
};

masterSeed();
