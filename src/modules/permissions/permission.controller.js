const Permission = require('./permission.model');

exports.createPermission = async (req, res) => {
    try {
        const permission = await Permission.create(req.body);
        res.status(201).json(permission);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.getPermissions = async (req, res) => {
    try {
        const permissions = await Permission.find();
        res.json(permissions);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updatePermission = async (req, res) => {
    try {
        const permission = await Permission.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!permission) return res.status(404).json({ message: 'Permission not found' });
        res.json(permission);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.deletePermission = async (req, res) => {
    try {
        const Role = require('../roles/role.model');
        const roleUsingPermission = await Role.findOne({ permissionIds: req.params.id });
        
        if (roleUsingPermission) {
            return res.status(400).json({ 
                message: `Cannot delete permission. It is currently assigned to the '${roleUsingPermission.name}' role.` 
            });
        }

        const permission = await Permission.findByIdAndDelete(req.params.id);
        if (!permission) return res.status(404).json({ message: 'Permission not found' });
        res.json({ message: 'Permission deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
