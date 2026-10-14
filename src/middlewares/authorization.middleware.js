const models = require("../models");

const Authorization = async (req, res, next) => {
    try {
        // Step 1 - Use pre-populated role from Authentication middleware
        const role = req.user.roleId;

        if (!role || !role.permissionIds || role.permissionIds.length === 0) {
            // Special case: Allow Super Admin and Library Admin to bypass permission checks if permissions aren't explicitly assigned
            if ((role && role.name === 'Super Admin') || req.userType === 'admin' || req.userType === 'superadmin') {
                return next();
            }

            return res.status(403).json({
                success: false,
                code: 403,
                message: 'You do not have sufficient permissions to perform this action. Please contact your administrator for permissions.'
            });
        }

        // Master bypass for Super Admin and Library Admin
        if (role.name === 'Super Admin' || req.userType === 'admin' || req.userType === 'superadmin') {
            return next();
        }

        const urlPath = req.originalUrl.split('?')[0];

        // Step 2 - Extract the action segment of the URL
        // Remove query parameters
        const segments = urlPath.split('/').filter(segment => segment.length > 0);

        // Find the most relevant segment (ignore MongoDB ObjectIds at the end)
        let actionSegment = segments[segments.length - 1];
        if (actionSegment.match(/^[0-9a-fA-F]{24}$/) && segments.length > 1) {
            // If the last segment is an ID, the action is likely the second-to-last segment
            actionSegment = segments[segments.length - 2];
        }

        // Step 3 - Get all permitted routes for the user role
        const permittedRoutes = role.permissionIds.map(permission => permission.route);

        // Step 4 - Check if the current action segment is authorized
        const isAuthorized = permittedRoutes.some(route => {
            if (route === actionSegment) return true;
            
            // Allow singular/plural mismatches (e.g., get-admin vs get-admins)
            const normalizedRoute = route.replace(/s$/, '');
            const normalizedAction = actionSegment.replace(/s$/, '');
            if (normalizedRoute === normalizedAction) return true;

            // update-status is governed by the update permission of the same resource (update-admin),
            // never by an unrelated update-* permission such as update-student
            if (actionSegment === 'update-status' && route === 'update-admin') return true;
            
            return false;
        });

        if (isAuthorized) {
            next();
        } else {
            return res.status(403).json({
                success: false,
                message: `You are not authorized for this action! (${actionSegment})`,
            });
        }

    } catch (error) {
        console.error('Authorization error:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error.'
        });
    }
};


module.exports = Authorization;
