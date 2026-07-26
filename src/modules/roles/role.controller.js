const Role = require('./role.model');

exports.createRole = async (req, res) => {
    try {
        const role = await Role.create({ ...req.body, createdBy: req.user?._id });
        res.status(201).json(role);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.getRoles = async (req, res) => {
    try {
        let filter = {};

        // If the user is a library admin, only show roles they created, plus the default 'Staff' role
        if (req.userType === 'admin') {
            filter = {
                $or: [
                    { createdBy: req.user._id },
                    { name: 'Staff', isDefault: true } // Show default Staff role so they can assign it
                ]
            };
        } else if (req.userType !== 'superadmin' && req.userType !== 'admin') {
            // Staff or others only see roles created by their library admin
            filter = { createdBy: req.user.libraryId?.createdBy || req.user.libraryId };
        }

        const roles = await Role.find(filter)
            .populate('permissionIds')
            .populate('sidebarMenuIds');
        res.json(roles);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getRoleById = async (req, res) => {
    try {
        const role = await Role.findById(req.params.id)
            .populate('permissionIds')
            .populate('sidebarMenuIds');
        if (!role) return res.status(404).json({ message: 'Role not found' });
        res.json(role);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateRole = async (req, res) => {
    try {
        const existingRole = await Role.findById(req.params.id);
        if (!existingRole) return res.status(404).json({ message: 'Role not found' });

        if (existingRole.isDefault) {
            return res.status(400).json({ message: 'Cannot update default system roles' });
        }

        const role = await Role.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(role);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deleteRole = async (req, res) => {
    try {
        const role = await Role.findById(req.params.id);
        if (!role) return res.status(404).json({ message: 'Role not found' });

        if (role.isDefault) {
            return res.status(400).json({ message: 'Cannot delete default system roles' });
        }

        const Admin = require('../admins/admin.model');
        const Library = require('../libraries/library.model');
        
        const assignedAdmins = await Admin.countDocuments({ roleId: role._id, isDeleted: false });
        const assignedLibraries = await Library.countDocuments({ roleId: role._id, isDeleted: false });
        
        if (assignedAdmins > 0 || assignedLibraries > 0) {
            let dependencies = [];
            if (assignedAdmins > 0) dependencies.push(`${assignedAdmins} Admin/Staff members`);
            if (assignedLibraries > 0) dependencies.push(`${assignedLibraries} Library accounts`);
            
            const message = `Cannot delete role. It is currently assigned to: ${dependencies.join(', ')}.`;
            return res.status(400).json({ message });
        }

        await Role.findByIdAndDelete(req.params.id);
        res.json({ message: 'Role deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
