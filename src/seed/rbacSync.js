require('dotenv').config();
const mongoose = require('mongoose');
const Role = require('../modules/roles/role.model');
const SidebarMenu = require('../modules/sidebar/sidebar.model');
const Permission = require('../modules/permissions/permission.model');
const config = require('../config/config');

const syncRBAC = async () => {
    try {
        await mongoose.connect(config.mongoose.url);
        console.log('Connected to MongoDB for RBAC sync');

        // 1. Get all SidebarMenu IDs
        const sidebarMenus = await SidebarMenu.find({}, '_id');
        const sidebarMenuIds = sidebarMenus.map(m => m._id);

        // 2. Get all Permission IDs
        const permissions = await Permission.find({}, '_id');
        const permissionIds = permissions.map(p => p._id);

        // 3. Find Super Admin role and update
        const role = await Role.findOneAndUpdate(
            { name: 'Super Admin' },
            {
                sidebarMenuIds: sidebarMenuIds,
                permissionIds: permissionIds
            },
            { new: true, upsert: true }
        );

        console.log(`Updated 'Super Admin' role with ${sidebarMenuIds.length} menus and ${permissionIds.length} permissions.`);
        process.exit(0);
    } catch (error) {
        console.error('RBAC Sync failed:', error);
        process.exit(1);
    }
};

syncRBAC();
