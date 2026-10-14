const libraryService = require('../services/library.service');

// Create a new library registration
exports.createLibrary = async (req, res, next) => {
    try {
        const creatorInfo = req.user ? { id: req.user.id } : null;
        const libraryData = { ...req.body };

        // Parse settings/workingHours if it comes as a string (from form-data)
        if (typeof libraryData.settings === 'string') {
            try {
                libraryData.settings = JSON.parse(libraryData.settings);
            } catch (e) {
                // Keep as is or handle error
            }
        }
        if (typeof libraryData.workingHours === 'string') {
            try {
                libraryData.workingHours = JSON.parse(libraryData.workingHours);
            } catch (e) {
                // Keep as is or handle error
            }
        }

        // Handle file uploads
        if (req.files) {
            if (req.files.profileImage) {
                libraryData.profileImage = req.files.profileImage[0].path;
            }
            if (req.files.logo) {
                libraryData.logo = req.files.logo[0].path;
            }
            if (req.files.photos) {
                libraryData.photos = req.files.photos.map(file => file.path);
            }
        }

        const library = await libraryService.registerLibrary(libraryData, creatorInfo);

        res.status(201).json({
            success: true,
            message: "Library registered successfully",
            data: library
        });
    } catch (error) {
        next(error);
    }
};

// Library Login
exports.loginLibrary = async (req, res, next) => {
    try {
        const { mobile, email, password } = req.body;
        const identifier = mobile || email;
        const result = await libraryService.loginLibrary(identifier, password);

        res.status(200).json({
            success: true,
            message: "Library login successful",
            data: result.library || result,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

// Get all libraries with search and pagination
exports.getAllLibraries = async (req, res, next) => {
    try {
        const { page = 1, limit = 10, search = "", status = "" } = req.query;

        const filter = { isDeleted: false };
        if (status) filter.status = status;
        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: "i" } },
                { ownerName: { $regex: search, $options: "i" } },
                { mobile: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } }
            ];
        }

        const result = await libraryService.queryLibraries(filter, { page, limit });

        res.status(200).json({
            success: true,
            message: "Libraries retrieved successfully",
            data: result.results || result,
            ...result
        });
    } catch (error) {
        next(error);
    }
};

// Get single library
exports.getLibraryById = async (req, res, next) => {
    try {
        const library = await libraryService.getLibraryById(req.params.id);
        res.status(200).json({
            success: true,
            message: "Library retrieved successfully",
            data: library
        });
    } catch (error) {
        next(error);
    }
};

// Update library
exports.updateLibrary = async (req, res, next) => {
    try {
        const updateData = { ...req.body };

        // Parse settings/workingHours if it comes as a string (from form-data)
        if (typeof updateData.settings === 'string') {
            try {
                updateData.settings = JSON.parse(updateData.settings);
            } catch (e) {
                // Keep as is or handle error
            }
        }
        if (typeof updateData.workingHours === 'string') {
            try {
                updateData.workingHours = JSON.parse(updateData.workingHours);
            } catch (e) {
                // Keep as is or handle error
            }
        }

        // Handle file uploads
        if (req.files) {
            if (req.files.profileImage) {
                updateData.profileImage = req.files.profileImage[0].path;
            }
            if (req.files.logo) {
                updateData.logo = req.files.logo[0].path;
            }
            if (req.files.photos) {
                updateData.photos = req.files.photos.map(file => file.path);
            }
        }

        if (updateData.existingPhotos !== undefined) {
            try {
                const existing = JSON.parse(updateData.existingPhotos);
                updateData.photos = updateData.photos ? [...existing, ...updateData.photos] : existing;
            } catch (e) {
                console.error("Error parsing existingPhotos", e);
            }
        }

        if (updateData.profileImage === 'null' || updateData.profileImage === '' || updateData.profileImage === 'REMOVE_IMAGE' || updateData.profileImage === 'uploads/profiles/default-avatar.png') {
            updateData.profileImage = null;
        }
        if (updateData.logo === 'null' || updateData.logo === '' || updateData.logo === 'REMOVE_IMAGE') {
            updateData.logo = null;
        }

        const library = await libraryService.updateLibraryById(req.params.id, updateData);
        res.status(200).json({
            success: true,
            message: "Library updated successfully",
            data: library
        });
    } catch (error) {
        next(error);
    }
};

// Update library status
exports.updateLibraryStatus = async (req, res, next) => {
    try {
        const { status } = req.body;
        const library = await libraryService.updateStatus(req.params.id, status);

        res.status(200).json({
            success: true,
            message: `Library status updated to ${status}`,
            data: library
        });
    } catch (error) {
        next(error);
    }
};

// Soft delete library
exports.deleteLibrary = async (req, res, next) => {
    try {
        await libraryService.deleteLibraryById(req.params.id);
        res.status(200).json({
            success: true,
            message: "Library deleted successfully"
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Get logged in library profile
 */
exports.getProfile = async (req, res, next) => {
    try {
        // req.user is already the Library document (populated) from the Authentication middleware
        if (!req.user) {
            return res.status(404).json({ success: false, message: "Profile not found" });
        }

        console.log('Fetching Profile for Library ID:', req.user._id);
        console.log('Profile Data Sample:', { name: req.user.name, email: req.user.email });

        res.status(200).json({
            success: true,
            message: "Profile fetched successfully",
            data: req.user
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Update logged in library profile
 */
exports.updateProfile = async (req, res, next) => {
    try {
        const updateData = { ...req.body };

        // Parse settings/workingHours if it comes as a string (from form-data)
        if (typeof updateData.settings === 'string') {
            try {
                updateData.settings = JSON.parse(updateData.settings);
            } catch (e) {
                // Keep as is or handle error
            }
        }
        if (typeof updateData.workingHours === 'string') {
            try {
                updateData.workingHours = JSON.parse(updateData.workingHours);
            } catch (e) {
                // Keep as is or handle error
            }
        }

        // Handle image removal flags
        if (req.files) {
            if (req.files.profileImage) {
                updateData.profileImage = req.files.profileImage[0].path;
            }
            if (req.files.logo) {
                updateData.logo = req.files.logo[0].path;
            }
            if (req.files.photos) {
                updateData.photos = req.files.photos.map(file => file.path);
            }
        }

        if (updateData.existingPhotos !== undefined) {
            try {
                const existing = JSON.parse(updateData.existingPhotos);
                updateData.photos = updateData.photos ? [...existing, ...updateData.photos] : existing;
            } catch (e) {
                console.error("Error parsing existingPhotos", e);
            }
        }

        if (updateData.profileImage === 'null' || updateData.profileImage === '' || updateData.profileImage === 'REMOVE_IMAGE' || updateData.profileImage === 'uploads/profiles/default-avatar.png') {
            updateData.profileImage = null;
        }
        if (updateData.logo === 'null' || updateData.logo === '' || updateData.logo === 'REMOVE_IMAGE') {
            updateData.logo = null;
        }

        const library = await libraryService.updateLibraryById(req.user._id, updateData);
        res.status(200).json({
            success: true,
            message: "Profile updated successfully",
            data: library
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Change library password
 */
exports.changePassword = async (req, res, next) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword) {
            return res.status(400).json({ success: false, message: 'New password is required' });
        }
        
        await libraryService.changePassword(req.user._id, newPassword);
        res.status(200).json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
        next(error);
    }
};
