const jwt = require('jsonwebtoken');
const Admin = require('../modules/admins/admin.model');
const Role = require('../modules/roles/role.model');
const config = require('../config/config');

const Authentication = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        const decoded = jwt.verify(token, config.jwt.secret || 'secret_key');
        console.log('Decoded Token:', decoded);
        let user;

        if (decoded.type === 'student') {
            const Student = require('../modules/students/student.model');
            user = await Student.findById(decoded.id).populate('libraryId');
            if (!user || user.isDeleted) {
                return res.status(401).json({ message: 'Student not found or inactive' });
            }
            user.userType = 'student';
        } else {
            // This covers 'superadmin', 'admin', and 'staff'
            user = await Admin.findById(decoded.id)
                .populate({
                    path: 'roleId',
                    populate: { path: 'permissionIds' }
                })
                .populate('libraryId');
            if (!user || !user.status) {
                return res.status(401).json({ message: 'User not found or inactive' });
            }
            // user.userType is already defined in the model
        }

        console.log('User Found:', user ? user._id : 'NONE');

        // Attach permissions to request for easy access in middleware
        req.user = user;
        req.userType = user.userType; // Use the type from the database
        req.user.sub = decoded.id; 
        req.permissions = user.roleId?.permissionIds?.map(p => p.key) || [];

        next();
    } catch (error) {
        console.error('Auth Middleware Error:', error);
        return res.status(401).json({ message: 'Invalid token' });
    }
};

module.exports = Authentication;
