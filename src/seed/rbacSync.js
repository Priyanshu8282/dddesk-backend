require('dotenv').config();
const mongoose = require('mongoose');
const Role = require('../models/role.model');
const SidebarMenu = require('../models/sidebar.model');
const Permission = require('../models/permission.model');
const config = require('../config/config');
const { ALL, ROLE_TEMPLATES, ROLE_MENU_TITLES } = require('./permissionCatalog');

/**
 * Idempotent RBAC sync (does not delete anything):
 *  - upserts every permission in the catalog (by key)
 *  - gives the Super Admin role every permission and menu
 *  - gives the Admin (owner) system role every tenant-scope permission
 *  - creates Staff / Receptionist / Accountant / Manager system role templates with defaults
 *    (permission lists of existing templates are only extended, never reduced)
 * Assumes an open mongoose connection.
 */
const syncRBAC = async () => {
    for (const p of ALL) {
        await Permission.updateOne(
            { key: p.key },
            { $set: { name: p.name, module: p.module, description: p.description || '', scope: p.scope || 'tenant', ...(p.route ? { route: p.route } : {}) } },
            { upsert: true }
        );
    }

    const permissions = await Permission.find({}, '_id key scope');
    const byKey = new Map(permissions.map((p) => [p.key, p._id]));
    const tenantPermIds = permissions.filter((p) => p.scope !== 'platform').map((p) => p._id);
    const sidebarMenuIds = (await SidebarMenu.find({}, '_id')).map((m) => m._id);

    await Role.updateOne(
        { name: 'Super Admin', libraryId: null },
        { $set: { permissionIds: permissions.map((p) => p._id), sidebarMenuIds, isDefault: true, status: true } },
        { upsert: true }
    );
    await Role.updateOne(
        { name: 'Admin', libraryId: null },
        { $set: { permissionIds: tenantPermIds, isDefault: true, status: true } },
        { upsert: true }
    );
    for (const [name, keys] of Object.entries(ROLE_TEMPLATES)) {
        const ids = keys.map((k) => byKey.get(k)).filter(Boolean);
        const menus = await SidebarMenu.find({ title: { $in: ROLE_MENU_TITLES[name] || [] }, userType: { $in: ['admin', 'staff'] } }, '_id');
        await Role.updateOne(
            { name, libraryId: null },
            { $addToSet: { permissionIds: { $each: ids }, sidebarMenuIds: { $each: menus.map((m) => m._id) } }, $set: { isDefault: true, status: true } },
            { upsert: true }
        );
    }
    return { permissions: permissions.length, tenantPermissions: tenantPermIds.length, menus: sidebarMenuIds.length };
};

module.exports = { syncRBAC };

if (require.main === module) {
    (async () => {
        try {
            await mongoose.connect(config.mongoose.url);
            console.log('Connected to MongoDB for RBAC sync');
            const r = await syncRBAC();
            console.log(`RBAC synced: ${r.permissions} permissions (${r.tenantPermissions} tenant), ${r.menus} menus.`);
            process.exit(0);
        } catch (error) {
            console.error('RBAC Sync failed:', error);
            process.exit(1);
        }
    })();
}
