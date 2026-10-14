const Library = require('../models/library.model');
const Role = require('../models/role.model');
const jwt = require("jsonwebtoken");
const ApiError = require('../utils/ApiError');
const config = require('../config/config');

/**
 * Register a new library
 * @param {Object} libraryBody
 * @param {Object} creatorInfo
 * @returns {Promise<Library>}
 */
const registerLibrary = async (libraryBody, creatorInfo) => {
    const { mobile, roleId } = libraryBody;

    // Check if library with mobile already exists
    const existingLibrary = await Library.findOne({ mobile });
    if (existingLibrary) {
        throw new ApiError(400, "Library with this mobile number already exists");
    }

    // Role Handling
    let finalRoleId = roleId;
    if (!finalRoleId) {
        const defaultRole = await Role.findOne({ name: 'Admin' });
        if (!defaultRole) {
            throw new ApiError(400, "Default 'Admin' role not found. Please provide a roleId.");
        }
        finalRoleId = defaultRole._id;
    }

    const library = new Library({
        ...libraryBody,
        roleId: finalRoleId,
        createdBy: creatorInfo ? "SUPER_ADMIN" : "SELF",
        createdById: creatorInfo ? creatorInfo.id : null
    });

    return await library.save();
};

/**
 * Login Admin
 * @param {string} mobile
 * @param {string} password
 * @returns {Promise<Object>}
 */
const loginLibrary = async (identifier, password) => {
    if (!identifier || !password) {
        throw new ApiError(400, "Mobile/Email and password are required");
    }

    const library = await Library.findOne({
        $or: [{ mobile: identifier }, { email: identifier }],
        isDeleted: false
    }).populate({
        path: 'roleId',
        populate: { path: 'permissionIds' }
    });

    if (!library) {
        throw new ApiError(401, "Invalid credentials");
    }

    const isMatch = await library.comparePassword(password);
    if (!isMatch) {
        throw new ApiError(401, "Invalid credentials");
    }

    const permissions = library.roleId?.permissionIds?.map(p => p.key) || [];

    const token = jwt.sign(
        { id: library._id, mobile: library.mobile, type: 'admin' },
        config.jwt.secret || 'secret_key',
        { expiresIn: config.jwt.expiration }
    );

    return {
        token,
        user: {
            id: library._id,
            name: library.name,
            ownerName: library.ownerName,
            mobile: library.mobile,
            email: library.email,
            profileImage: library.profileImage,
            libraryCode: library.libraryCode,
            slug: library.slug,
            role: library.roleId?.name || 'Admin',
            userType: 'admin',
            status: library.status,
            permissions
        }
    };
};

/**
 * Query for libraries
 * @param {Object} filter
 * @param {Object} options
 * @returns {Promise<Object>}
 */
const queryLibraries = async (filter, options) => {
    const { page = 1, limit = 10 } = options;
    const skip = (page - 1) * limit;

    const total = await Library.countDocuments(filter);
    const libraries = await Library.find(filter)
        .populate("roleId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

    return {
        libraries,
        pagination: {
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            pages: Math.ceil(total / limit)
        }
    };
};

/**
 * Get library by id
 * @param {string} id
 * @returns {Promise<Library>}
 */
const getLibraryById = async (id) => {
    const library = await Library.findById(id).populate("roleId", "name");
    if (!library || library.isDeleted) {
        throw new ApiError(404, "Library not found");
    }
    return library;
};

/**
 * Update library by id
 * @param {string} id
 * @param {Object} updateBody
 * @returns {Promise<Library>}
 */
const updateLibraryById = async (id, updateBody) => {
    const library = await getLibraryById(id);

    if (updateBody.mobile) {
        const existing = await Library.findOne({ mobile: updateBody.mobile, _id: { $ne: id } });
        if (existing) {
            throw new ApiError(400, "Mobile number already in use by another library");
        }
    }

    Object.assign(library, updateBody);
    return await library.save();
};

/**
 * Update status
 * @param {string} id
 * @param {string} status
 * @returns {Promise<Library>}
 */
const updateStatus = async (id, status) => {
    const library = await getLibraryById(id);
    library.status = status;
    return await library.save();
};

/**
 * Soft delete library
 * @param {string} id
 * @returns {Promise<Library>}
 */
const deleteLibraryById = async (id) => {
    const library = await getLibraryById(id);
    library.isDeleted = true;
    return await library.save();
};

/**
 * Change library password
 * @param {string} id
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<Library>}
 */
const changePassword = async (id, newPassword) => {
    const library = await Library.findById(id);
    if (!library) {
        throw new ApiError(404, "Library not found");
    }

    library.password = newPassword;
    return await library.save();
};

module.exports = {
    registerLibrary,
    loginLibrary,
    queryLibraries,
    getLibraryById,
    updateLibraryById,
    updateStatus,
    deleteLibraryById,
    changePassword
};
