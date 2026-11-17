const mongoose = require('mongoose');
require('dotenv').config();

const SidebarMenu = require('../src/models/sidebar.model');
const Permission = require('../src/models/permission.model');
const Role = require('../src/models/role.model');

const addLibrarySidebar = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/MgiBasket');
        console.log('Connected to MongoDB');

        // 1. Create Sidebar Menus
        const menus = [
            { title: 'Library Management', classChange: 'menu-title', module_id: 'library_mgmt', parent_module_id: '-1', hasMenu: false },
            {
                title: 'Libraries',
                iconStyle: "<i className='la la-book'></i>",
                parent_module_id: 'library_mgmt',
                hasMenu: true,
                content: [
                    { title: 'Add New', to: 'libraries/add-library' },
                    { title: 'List', to: 'libraries/list-libraries' }
                ]
            }
        ];

        const insertedMenus = await SidebarMenu.insertMany(menus);
        console.log('Inserted Library Sidebar Menus.');

        // 2. Create Permissions
        const libraryPermissions = [
            { name: 'Create Library', key: 'create_libraries', module: 'LIBRARY', route: 'register', description: 'Allows registering a new library' },
            { name: 'Read Libraries', key: 'read_libraries', module: 'LIBRARY', route: 'all', description: 'Allows viewing library lists and details' },
            { name: 'Update Library', key: 'update_libraries', module: 'LIBRARY', route: 'update', description: 'Allows updating library information' },
            { name: 'Delete Library', key: 'delete_libraries', module: 'LIBRARY', route: 'delete', description: 'Allows deleting a library' }
        ];

        const insertedPermissions = await Permission.insertMany(libraryPermissions);
        console.log('Inserted Library Permissions.');

        // 3. Add to Super Admin Role
        const superAdminRole = await Role.findOne({ name: 'Super Admin' });
        if (superAdminRole) {
            superAdminRole.sidebarMenuIds.push(...insertedMenus.map(m => m._id));
            superAdminRole.permissionIds.push(...insertedPermissions.map(p => p._id));
            await superAdminRole.save();
            console.log('Updated Super Admin Role with Library menus and permissions.');
        } else {
            console.warn('Super Admin Role not found. Please assign menus/permissions manually.');
        }

        console.log('Library Sidebar integration completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('Error integrating Library Sidebar:', error);
        process.exit(1);
    }
};

addLibrarySidebar();
