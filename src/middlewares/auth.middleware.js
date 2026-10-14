const jwt = require('jsonwebtoken');
const Admin = require('../models/admin.model');
const Role = require('../models/role.model');
const config = require('../config/config');

const Authentication = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).json({ success: false, code: 401, message: 'Authentication required' });
        }

        const decoded = jwt.verify(token, config.jwt.secret);
        let user;

        if (decoded.type === 'student') {
            const Student = require('../models/student.model');
            user = await Student.findById(decoded.id).populate('libraryId');
            if (!user || user.isDeleted) {
                return res.status(401).json({ success: false, code: 401, message: 'Student not found or inactive' });
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
                return res.status(401).json({ success: false, code: 401, message: 'User not found or inactive' });
            }
            // user.userType is already defined in the model
        }

        // Attach permissions to request for easy access in middleware
        req.user = user;
        req.userType = user.userType; // Use the type from the database
        req.user.sub = decoded.id; 
        req.permissions = user.roleId?.permissionIds?.map(p => p.key) || [];

        next();
    } catch (error) {
        return res.status(401).json({ success: false, code: 401, message: 'Invalid or expired token' });
    }
};

module.exports = Authentication;
