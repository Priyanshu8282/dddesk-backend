const permissionMiddleware = (permissionKey) => {
    return (req, res, next) => {
        if (!req.permissions || !req.permissions.includes(permissionKey)) {
            return res.status(403).json({
                message: "Forbidden: You do not have permission to perform this action"
            });
        }
        next();
    };
};

module.exports = permissionMiddleware;
