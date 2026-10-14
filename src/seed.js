const mongoose = require('mongoose');
require('dotenv').config();

const SidebarMenu = require('./models/sidebar.model');
const Permission = require('./models/permission.model');
const Role = require('./models/role.model');
const Admin = require('./models/admin.model');

// DESTRUCTIVE dev-only reset (wipes admins, roles, permissions, menus). For normal setup use `npm run seed` (idempotent).
const seedDB = async () => {
    try {
        if (process.env.CONFIRM_RESET !== 'yes') {
            console.error('Refusing to wipe the database. Set CONFIRM_RESET=yes to run this destructive reset, or use npm run seed.');
            process.exit(1);
        }
        await mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/MgiBasket');
        console.log('Connected to MongoDB');

        // Delete all existing entries
        await SidebarMenu.deleteMany({});
        await Permission.deleteMany({});
        await Role.deleteMany({});
        await Admin.deleteMany({});
        console.log('Cleared existing data (Admins, Roles, Menus, Permissions).');

        // 1. Create Sidebar Menus
        const menus = [
            { title: 'Main Menu', classChange: 'menu-title', module_id: 'main_menu', parent_module_id: '-1', hasMenu: false },
            { title: 'Dashboard', iconStyle: "<i className='la la-home'></i>", to: 'dashboard', parent_module_id: 'main_menu', hasMenu: false },

            { title: 'Library Management', classChange: 'menu-title', module_id: 'lib_mgmt', parent_module_id: '-1', hasMenu: false },
            {
                title: 'Libraries',
                iconStyle: "<i className='la la-university'></i>",
                parent_module_id: 'lib_mgmt',
                hasMenu: true,
                content: [
                    { title: 'Add New', to: 'libraries/add-library' },
                    { title: 'List', to: 'libraries/list-libraries' }
                ]
            },

            { title: 'Employee Management', classChange: 'menu-title', module_id: 'emp_mgmt', parent_module_id: '-1', hasMenu: false },
            {
                title: 'Employees',
                iconStyle: "<i className='la la-users'></i>",
                parent_module_id: 'emp_mgmt',
                hasMenu: true,
                content: [
                    { title: 'Add New', to: 'admins/create-admin' },
                    { title: 'List', to: 'admins/get-admins' }
                ]
            },

            { title: 'Access Control', classChange: 'menu-title', module_id: 'access_ctrl', parent_module_id: '-1', hasMenu: false },
            {
                title: 'Role Management',
                iconStyle: "<i className='la la-shield'></i>",
                parent_module_id: 'access_ctrl',
                hasMenu: true,
                content: [
                    { title: 'Add New', to: 'roles/create-role' },
                    { title: 'List', to: 'roles/get-roles' }
                ]
            }
        ];

        await SidebarMenu.insertMany(menus);
        console.log('Inserted new Sidebar Menus successfully.');

        // 2. Create Permissions
        const rolePermissions = [
            { name: 'Create Role', key: 'CREATE_ROLE', module: 'ROLE', route: 'create-role', description: 'Allows creating a new role' },
            { name: 'View Roles', key: 'VIEW_ROLES', module: 'ROLE', route: 'get-roles', description: 'Allows viewing roles list' },
            { name: 'Update Role', key: 'UPDATE_ROLE', module: 'ROLE', route: 'update-role', description: 'Allows updating an existing role' },
            { name: 'Delete Role', key: 'DELETE_ROLE', module: 'ROLE', route: 'delete-role', description: 'Allows deleting a role' }
        ];

        await Permission.insertMany(rolePermissions);
        console.log('Inserted new Permissions.');

        // 3. Create Roles
        const allMenus = await SidebarMenu.find({}, '_id');
        const allPermissions = await Permission.find({}, '_id');

        const superAdminRole = await Role.create({
            name: 'Super Admin',
            isDefault: true,
            status: true,
            sidebarMenuIds: allMenus.map(m => m._id),
            permissionIds: allPermissions.map(p => p._id)
        });

        const libraryAdminRole = await Role.create({
            name: 'Admin',
            isDefault: true,
            status: true,
            sidebarMenuIds: allMenus.map(m => m._id),
            permissionIds: allPermissions.map(p => p._id)
        });

        const staffRole = await Role.create({
            name: 'Staff',
            isDefault: true,
            status: true,
            sidebarMenuIds: [],
            permissionIds: []
        });
        console.log('Created Super Admin, Admin, and Staff roles.');

        // 4. Create Default Super Admin
        await Admin.create({
            name: 'Super Admin',
            email: 'admin@example.com',
            password: 'password123', // Will be hashed by pre-save hook
            userType: 'superadmin',
            roleId: superAdminRole._id,
            mobile: '1234567890',
            status: true
        });
        console.log('Created default Super Admin user: admin@example.com / password123');

        console.log('Seeding completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding database:', error);
        process.exit(1);
    }
};

seedDB();
