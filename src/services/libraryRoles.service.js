const Role = require('../models/role.model');

/**
 * The basic roles every library starts with. Each library gets its OWN copy (so the owner can edit it),
 * created from the platform templates (libraryId = null) that seed/rbacSync.js keeps up to date.
 */
const BASIC_ROLES = [
  { name: 'Staff', description: 'Front-desk helper: students, seats, attendance and enquiries.' },
  { name: 'Receptionist', description: 'Registers students, assigns seats and plans, answers enquiries.' },
  { name: 'Accountant', description: 'Collects fees, tracks expenses and reads reports.' },
  { name: 'Manager', description: 'Runs the daily work: students, seats, content, fees and reports.' },
];

const nameRe = (n) => new RegExp(`^${String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

/**
 * Makes sure the library has the basic roles. Existing roles (any spelling of the name) are left alone.
 * Returns { created: [names], roles: { Staff: role, ... } }.
 */
exports.provisionDefaultRoles = async (libraryId, createdBy = null) => {
  const created = [];
  const roles = {};
  for (const basic of BASIC_ROLES) {
    let role = await Role.findOne({ libraryId, name: nameRe(basic.name) });
    if (!role) {
      const template = await Role.findOne({ libraryId: null, name: basic.name });
      if (!template) continue; // platform templates not seeded yet (run `npm run seed`)
      try {
        role = await Role.create({
          name: basic.name,
          description: template.description || basic.description,
          libraryId,
          permissionIds: template.permissionIds,
          sidebarMenuIds: template.sidebarMenuIds,
          isDefault: false,
          status: true,
          createdBy: createdBy || undefined,
        });
        created.push(basic.name);
      } catch (e) {
        if (e && e.code === 11000) role = await Role.findOne({ libraryId, name: nameRe(basic.name) }); // created by a parallel request
        else throw e;
      }
    }
    if (role) roles[basic.name] = role;
  }
  return { created, roles };
};

exports.BASIC_ROLES = BASIC_ROLES;
