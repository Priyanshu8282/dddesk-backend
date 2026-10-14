require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Admin = require('../models/admin.model');
const Role = require('../models/role.model');
const Permission = require('../models/permission.model');
const SidebarMenu = require('../models/sidebar.model');
const config = require('../config/config');

const permissionsData = [
    { name: 'View Dashboard', key: 'VIEW_DASHBOARD', module: 'CORE', route: 'dashboard' },
    { name: 'View Employees', key: 'VIEW_ADMINS', module: 'EMPLOYEECONTROL', route: 'get-admins' },
    { name: 'Create Employee', key: 'CREATE_ADMIN', module: 'EMPLOYEECONTROL', route: 'create-admin' },
    { name: 'Update Employee', key: 'UPDATE_ADMIN', module: 'EMPLOYEECONTROL', route: 'update-admin' },
    { name: 'Delete Employee', key: 'DELETE_ADMIN', module: 'EMPLOYEECONTROL', route: 'delete-admin' },
    { name: 'View Roles', key: 'VIEW_ROLES', module: 'PERMISSIONCONTROL', route: 'get-roles' },
    { name: 'Create Role', key: 'CREATE_ROLE', module: 'PERMISSIONCONTROL', route: 'create-role' },
    { name: 'Update Role', key: 'UPDATE_ROLE', module: 'PERMISSIONCONTROL', route: 'update-role' },
    { name: 'Delete Role', key: 'DELETE_ROLE', module: 'PERMISSIONCONTROL', route: 'delete-role' },
    { name: 'View Permissions', key: 'VIEW_PERMISSIONS', module: 'PERMISSIONCONTROL', route: 'get-permissions' },
    { name: 'Create Permission', key: 'CREATE_PERMISSION', module: 'PERMISSIONCONTROL', route: 'create-permission' },
    { name: 'Update Permission', key: 'UPDATE_PERMISSION', module: 'PERMISSIONCONTROL', route: 'update-permission' },
    { name: 'Delete Permission', key: 'DELETE_PERMISSION', module: 'PERMISSIONCONTROL', route: 'delete-permission' },
    { name: 'Manage Sidebar', key: 'MANAGE_SIDEBAR', module: 'SIDEBARCONTROL', route: 'create-menu' },
    { name: 'View Sidebar Menus', key: 'VIEW_SIDEBAR', module: 'SIDEBARCONTROL', route: 'get-menus' },
    
    // Library Management Permissions
    { name: 'View Libraries', key: 'VIEW_LIBRARIES', module: 'LIBRARYCONTROL', route: 'get-libraries' },
    { name: 'Create Library', key: 'CREATE_LIBRARY', module: 'LIBRARYCONTROL', route: 'create-library' },
    { name: 'Update Library', key: 'UPDATE_LIBRARY', module: 'LIBRARYCONTROL', route: 'update-library' },
    { name: 'Delete Library', key: 'DELETE_LIBRARY', module: 'LIBRARYCONTROL', route: 'delete-library' },
    
    // Student Management Permissions
    { name: 'View Students', key: 'VIEW_STUDENTS', module: 'STUDENTCONTROL', route: 'get-students' },
    { name: 'Create Student', key: 'CREATE_STUDENT', module: 'STUDENTCONTROL', route: 'create-student' },
    { name: 'Update Student', key: 'UPDATE_STUDENT', module: 'STUDENTCONTROL', route: 'update-student' },
    { name: 'Delete Student', key: 'DELETE_STUDENT', module: 'STUDENTCONTROL', route: 'delete-student' },
    
    // Plan Management Permissions
    { name: 'View Plans', key: 'VIEW_PLANS', module: 'PLANCONTROL', route: 'get-plans' },
    { name: 'Create Plan', key: 'CREATE_PLAN', module: 'PLANCONTROL', route: 'create-plan' },
    { name: 'Update Plan', key: 'UPDATE_PLAN', module: 'PLANCONTROL', route: 'update-plan' },
    { name: 'Delete Plan', key: 'DELETE_PLAN', module: 'PLANCONTROL', route: 'delete-plan' }
];

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

        // 1. Seed Permissions
        await Permission.deleteMany({});
        const permissions = await Permission.insertMany(permissionsData);
        console.log('Permissions seeded.');

        // 2. Seed Sidebar Menus
        await SidebarMenu.deleteMany({});
        const sidebarMenus = await SidebarMenu.insertMany(sidebarData);
        console.log('Sidebar menus seeded.');

        // 3. Create Super Admin Role
        const superAdminRole = await Role.findOneAndUpdate(
            { name: 'Super Admin' },
            {
                permissionIds: permissions.map(p => p._id),
                sidebarMenuIds: sidebarMenus.map(m => m._id),
                status: true
            },
            { new: true, upsert: true }
        );
        console.log('Super Admin role created/updated.');

        // 4. Create Admin Role
        const adminPermissions = permissions.filter(p => 
            [
                'VIEW_DASHBOARD', 'VIEW_STUDENTS', 'CREATE_STUDENT', 'UPDATE_STUDENT', 'DELETE_STUDENT',
                'VIEW_ADMINS', 'CREATE_ADMIN', 'UPDATE_ADMIN', 'DELETE_ADMIN',
                'VIEW_PLANS', 'CREATE_PLAN', 'UPDATE_PLAN', 'DELETE_PLAN'
            ].includes(p.key)
        );
        const adminMenus = sidebarMenus.filter(m => 
            ['Dashboard', 'Database', 'Students', 'Student Management', 'Employees', 'Employee Management', 'Plans', 'Plan Management'].includes(m.title)
        );

        const adminRole = await Role.findOneAndUpdate(
            { name: 'Admin' },
            {
                permissionIds: adminPermissions.map(p => p._id),
                sidebarMenuIds: adminMenus.map(m => m._id),
                status: true
            },
            { new: true, upsert: true }
        );
        console.log('Admin role created/updated.');
        
        // 5. Create Staff Role
        const staffPermissions = permissions.filter(p => 
            [
                'VIEW_DASHBOARD', 'VIEW_STUDENTS', 'CREATE_STUDENT', 'UPDATE_STUDENT'
            ].includes(p.key)
        );
        const staffMenus = sidebarMenus.filter(m => 
            ['Dashboard', 'Students', 'Student Management'].includes(m.title)
        );

        const staffRole = await Role.findOneAndUpdate(
            { name: 'Staff' },
            {
                permissionIds: staffPermissions.map(p => p._id),
                sidebarMenuIds: staffMenus.map(m => m._id),
                status: true
            },
            { new: true, upsert: true }
        );
        console.log('Staff role created/updated.');
        
        // 6. Create Super Admin User
        const passwordHash = await bcrypt.hash('admin123', 10);
        await Admin.findOneAndUpdate(
            { email: 'admin@mgibasket.com' },
            {
                name: 'Super Admin',
                password: passwordHash,
                roleId: superAdminRole._id,
                mobile: '1234567890',
                status: true,
                isDeleted: false
            },
            { new: true, upsert: true }
        );
        console.log('Super Admin user created/updated.');

        process.exit(0);
    } catch (error) {
        console.error('Master seeding failed:', error);
        process.exit(1);
    }
};

masterSeed();
