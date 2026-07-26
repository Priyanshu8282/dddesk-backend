const Admin = require('./admin.model');
const Library = require('../libraries/library.model');
const Role = require('../roles/role.model');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const Student = require('../students/student.model');
const Payment = require('../payments/payment.model');
const Plan = require('../plans/plan.model');
const Notice = require('../notices/notice.model');
const Attendance = require('../attendance/attendance.model');

/**
 * 🔹 Create Employee (Staff)
 */
exports.createAdmin = async (req, res) => {
    try {
        let { 
            name, email, password, roleId, libraryId, 
            mobile, alternativeMobileNumber, joiningDate, 
            documentNames, address, city, state, country, pincode
        } = req.body;

        const existingAdmin = await Admin.findOne({ email });
        if (existingAdmin) {
            return res.status(400).json({ message: 'Email already exists' });
        }

        // Default to 'staff' if admin is creating
        let userType = 'staff';

        // If Adminting staff, force the role to 'Staff' and link to their library
        if (req.userType === 'admin') {
            if (!roleId) {
                const staffRole = await Role.findOne({ name: 'Staff' });
                if (!staffRole) {
                    return res.status(500).json({ message: "System Error: 'Staff' role is missing from the database." });
                }
                roleId = staffRole._id;
            }
            
            // Get the library ID from the logged-in Adminle
            libraryId = req.user.libraryId; 
        }

        // Handle Profile Image
        let profileImage = "";
        if (req.files && Array.isArray(req.files)) {
            const profileImageFile = req.files.find(f => f.fieldname === 'profileImage');
            if (profileImageFile) {
                profileImage = profileImageFile.path;
            }
        }

        // Handle Documents
        let adminDocuments = [];
        if (documentNames) {
            try {
                const names = JSON.parse(documentNames);
                if (Array.isArray(names)) {
                    adminDocuments = names.map((docName, index) => {
                        const docFile = req.files ? req.files.find(f => f.fieldname === `docFile_${index}`) : null;
                        return {
                            name: docName,
                            files: docFile ? [docFile.path] : []
                        };
                    });
                }
            } catch (e) {
                console.error("Error parsing documentNames:", e);
            }
        }

        const admin = await Admin.create({
            name,
            email,
            password, // Password hashing is handled in pre-save hook
            userType,
            roleId,
            libraryId,
            mobile,
            alternativeMobileNumber,
            joiningDate,
            address,
            city,
            state,
            country,
            pincode,
            documents: adminDocuments,
            profileImage,
            createdBy: req.user._id
        });

        res.status(201).json({ message: 'Employee created successfully', admin });
    } catch (error) {
        console.error("Create Admin Error:", error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * 🔹 Create Library (Dual-Table: Library + Admin)
 */
exports.createLibrary = async (req, res) => {
    try {
        const input = { ...req.body };
        
        // 1. Validation
        const existing = await Admin.findOne({ email: input.email });
        if (existing) return res.status(400).json({ message: "Admin with this email already exists" });

        // Parse settings if it comes as a string
        if (typeof input.settings === 'string') {
            try { input.settings = JSON.parse(input.settings); } catch (e) {}
        }
        if (typeof input.workingHours === 'string') {
            try { input.workingHours = JSON.parse(input.workingHours); } catch (e) {}
        }

        // 1.1 Role Handling
        let roleId = input.roleId;
        if (!roleId) {
            const libraryAdminRole = await Role.findOne({ name: 'Admin' });
            if (!libraryAdminRole) {
                return res.status(500).json({ message: "System Error: 'Admins missing from the database." });
            }
            roleId = libraryAdminRole._id;
        }

        // 2. Prepare File Data (multerUpload.any() returns req.files as an array)
        let profileImage = "";
        let logo = "";
        let photos = [];
        if (req.files) {
            if (Array.isArray(req.files)) {
                const profileImageFile = req.files.find(f => f.fieldname === 'profileImage');
                const logoFile = req.files.find(f => f.fieldname === 'logo');
                const photoFiles = req.files.filter(f => f.fieldname === 'photos');
                if (profileImageFile) profileImage = profileImageFile.path;
                if (logoFile) logo = logoFile.path;
                if (photoFiles.length > 0) photos = photoFiles.map(file => file.path);
            } else {
                if (req.files.profileImage) profileImage = req.files.profileImage[0].path;
                if (req.files.logo) logo = req.files.logo[0].path;
                if (req.files.photos) photos = req.files.photos.map(file => file.path);
            }
        }

        // 3. Create Library Record (Institutional Data)
        const library = new Library({
            name: input.name,
            ownerName: input.ownerName,
            mobile: input.mobile,
            alternativeMobileNumber: input.alternativeMobileNumber,
            email: input.email,
            password: input.password, // Still useful in library for direct management
            roleId: roleId,
            address: input.address,
            city: input.city,
            state: input.state,
            country: input.country,
            pincode: input.pincode,
            logo,
            photos,
            settings: input.settings,
            workingHours: input.workingHours,
            createdBy: req.user ? 'SUPER_ADMIN' : 'SELF',
            createdById: req.user ? req.user._id : null
        });
        await library.save();

        // 4. Create Admin Record (User Credentials linked to Library)
        const admin = await Admin.create({
            name: input.ownerName,
            email: input.email,
            password: input.password,
            userType: 'admin',
            roleId: roleId,
            libraryId: library._id,
            mobile: input.mobile,
            alternativeMobileNumber: input.alternativeMobileNumber,
            address: input.address,
            city: input.city,
            state: input.state,
            country: input.country,
            pincode: input.pincode,
            profileImage,
            createdBy: req.user ? req.user._id : null
        });

        res.status(201).json({
            success: true,
            message: "Library and Admin created successfully",
            data: { library, admin }
        });
    } catch (error) {
        console.error("Create Library Error:", error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * 🔹 Get Employees
 */
exports.getAdmins = async (req, res) => {
    try {
        const { page = 1, limit = 10, search = '', userType = 'staff', status = '', libraryId = '' } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);

        const filter = { isDeleted: false };
        if (userType && userType !== 'all') {
            filter.userType = userType;
        }

        // Role-based filtering
        if (req.userType === 'admin' || (req.user && req.user.libraryId)) {
            filter.libraryId = req.user.libraryId;
        } else if (req.userType === 'staff') {
            filter.libraryId = req.user.libraryId;
        } else if (libraryId) {
            filter.libraryId = libraryId;
        }

        if (status) {
            const statusLower = status.toLowerCase();
            if (statusLower === 'active') {
                filter.status = true;
            } else if (statusLower === 'inactive') {
                filter.status = false;
            }
        }

        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { mobile: { $regex: search, $options: 'i' } },
            ];
        }

        const total = await Admin.countDocuments(filter);
        const admins = await Admin.find(filter)
            .populate('roleId', 'name')
            .populate('libraryId', 'name')
            .sort({ createdAt: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum);

        // Calculate dynamic summary metrics for employees (staff) linked to the same library
        const summaryFilter = { isDeleted: false };
        if (userType && userType !== 'all') {
            summaryFilter.userType = userType;
        }
        if (req.userType === 'admin' || (req.user && req.user.libraryId)) {
            summaryFilter.libraryId = req.user.libraryId;
        } else if (req.userType === 'staff') {
            summaryFilter.libraryId = req.user.libraryId;
        } else if (libraryId) {
            summaryFilter.libraryId = libraryId;
        }

        const totalCount = await Admin.countDocuments(summaryFilter);
        const activeCount = await Admin.countDocuments({ ...summaryFilter, status: true });
        const inactiveCount = await Admin.countDocuments({ ...summaryFilter, status: false });

        const summary = {
            total: totalCount,
            active: activeCount,
            inactive: inactiveCount
        };

        res.json({
            success: true,
            data: admins,
            results: admins,
            totalResults: total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum),
            summary
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * 🔹 Get Libraries (Admin
 */
exports.getLibraries = async (req, res) => {
    try {
        const { page = 1, limit = 10, search = '', status = '' } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);

        const filter = { isDeleted: false, userType: 'admin' };
        
        if (status) {
            const statusLower = status.toLowerCase();
            if (statusLower === 'active') {
                filter.status = true;
            } else if (statusLower === 'inactive') {
                filter.status = false;
            }
        }

        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { mobile: { $regex: search, $options: 'i' } },
            ];
        }

        const total = await Admin.countDocuments(filter);
        const libraries = await Admin.find(filter)
            .populate('libraryId')
            .populate('roleId', 'name')
            .sort({ createdAt: -1 })
            .skip((pageNum - 1) * limitNum)
            .limit(limitNum);

        // Calculate system-wide overview metrics for libraries
        const totalCount = await Admin.countDocuments({ isDeleted: false, userType: 'admin' });
        const activeCount = await Admin.countDocuments({ isDeleted: false, userType: 'admin', status: true });
        const inactiveCount = await Admin.countDocuments({ isDeleted: false, userType: 'admin', status: false });

        const summary = {
            total: totalCount,
            active: activeCount,
            inactive: inactiveCount
        };

        res.json({
            success: true,
            data: libraries,
            total,
            page: pageNum,
            totalPages: Math.ceil(total / limitNum),
            summary
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getAdminById = async (req, res) => {
    try {
        // Fallback to req.user._id if no ID is provided in params (profile case)
        const id = req.params.id || req.user?._id;
        
        if (!id) {
            return res.status(404).json({ message: 'User ID not provided' });
        }

        const admin = await Admin.findById(id)
            .populate('roleId', 'name')
            .populate('libraryId');

        if (!admin) return res.status(404).json({ message: 'User not found' });
        res.json({ success: true, data: admin });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateAdmin = async (req, res) => {
    try {
        console.log("Entering updateAdmin...");
        console.log("Method:", req.method, "URL:", req.originalUrl);
        console.log("Params:", req.params);
        console.log("User in request:", req.user ? req.user._id : 'NONE');

        let updateData = { ...req.body };
        const id = req.params.id || req.user?._id;
        
        if (!id) {
            console.log("updateAdmin: NO ID FOUND");
            return res.status(404).json({ message: 'User ID not provided' });
        }
        console.log("updateAdmin: Target ID:", id);

        // Identify if this is a self-profile update
        const isSelfUpdate = !req.params.id || req.params.id === req.user?._id.toString();

        if (!isSelfUpdate) {
            // Logic for updating other users (e.g. staff)
            if (req.userType === 'admin') {
                if (!updateData.roleId) {
                    const staffRole = await Role.findOne({ name: 'Staff' });
                    if (staffRole) {
                        updateData.roleId = staffRole._id;
                    }
                }
                // Ensure staff is linked to the same library as the admin
                updateData.libraryId = req.user.libraryId; 
            }
        } else {
            // Profile update: protect sensitive fields
            delete updateData.roleId;
            delete updateData.libraryId;
            delete updateData.userType;
            delete updateData.status;
            delete updateData.isDeleted;
        }

        // Handle nested settings parse
        if (typeof updateData.settings === 'string') {
            try { updateData.settings = JSON.parse(updateData.settings); } catch (e) {}
        }
        if (typeof updateData.workingHours === 'string') {
            try { updateData.workingHours = JSON.parse(updateData.workingHours); } catch (e) {}
        }

        // Handle Documents Update
        if (updateData.documentNames) {
            const names = JSON.parse(updateData.documentNames);
            const admin = await Admin.findById(id); // Use the resolved id
            
            if (admin) {
                updateData.documents = names.map((docName, index) => {
                    const docFile = req.files ? req.files.find(f => f.fieldname === `docFile_${index}`) : null;
                    if (docFile) return { name: docName, files: [docFile.path] };
                    const existing = admin.documents.find(d => d.name === docName);
                    return existing || { name: docName, files: [] };
                });
            }
        }

        // Handle Images (supports both flat arrays from .any() and key-grouped objects from .fields())
        if (req.files) {
            let profileImageFile;
            let logoFile;
            let photos = [];

            if (Array.isArray(req.files)) {
                profileImageFile = req.files.find(f => f.fieldname === 'profileImage');
                logoFile = req.files.find(f => f.fieldname === 'logo');
                const photoFiles = req.files.filter(f => f.fieldname === 'photos');
                if (photoFiles.length > 0) photos = photoFiles.map(p => p.path);
            } else {
                if (req.files.profileImage) {
                    profileImageFile = req.files.profileImage[0];
                }
                if (req.files.logo) {
                    logoFile = req.files.logo[0];
                }
                if (req.files.photos) {
                    photos = req.files.photos.map(p => p.path);
                }
            }

            if (profileImageFile) updateData.profileImage = profileImageFile.path;
            if (logoFile) updateData.logo = logoFile.path;
            if (photos.length > 0) updateData.photos = photos;
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

        const updatedAdmin = await Admin.findByIdAndUpdate(
            id,
            { ...updateData, updatedBy: req.user._id },
            { new: true }
        );

        if (!updatedAdmin) return res.status(404).json({ message: 'User not found' });

        // 🔹 Sync with Library table if it's a admin
        if (updatedAdmin.userType === 'admin' && updatedAdmin.libraryId) {
            const libraryUpdate = {
                name: updatedAdmin.name,
                ownerName: updateData.ownerName || updatedAdmin.name, // Use ownerName from request if available
                mobile: updatedAdmin.mobile,
                alternativeMobileNumber: updatedAdmin.alternativeMobileNumber,
                email: updatedAdmin.email,
                address: updateData.address,
                city: updateData.city,
                state: updateData.state,
                country: updateData.country,
                pincode: updateData.pincode,
                logo: updateData.logo,
                photos: updateData.photos,
                settings: updateData.settings,
                workingHours: updateData.workingHours,
                website: updateData.website,
                gstNumber: updateData.gstNumber
            };
            
            // Clean undefined
            Object.keys(libraryUpdate).forEach(key => libraryUpdate[key] === undefined && delete libraryUpdate[key]);
            
            const libId = updatedAdmin.libraryId._id || updatedAdmin.libraryId;
            await Library.findByIdAndUpdate(libId, libraryUpdate);
        }

        const populatedAdmin = await Admin.findById(updatedAdmin._id)
            .populate('roleId', 'name')
            .populate('libraryId');

        res.json({ success: true, data: populatedAdmin });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateAdminStatus = async (req, res) => {
    try {
        const { status } = req.body;
        
        // Convert 'active'/'inactive' strings to Boolean for Admin record
        let adminStatus = status;
        if (status === 'active') adminStatus = true;
        if (status === 'inactive') adminStatus = false;

        const admin = await Admin.findByIdAndUpdate(
            req.params.id,
            { status: adminStatus, updatedBy: req.user?._id },
            { new: true }
        ).populate('libraryId');

        if (!admin) return res.status(404).json({ message: 'User not found' });

        // Sync with Library status if it's a admin
        if (admin.userType === 'admin' && admin.libraryId) {
            const libraryStatus = adminStatus ? 'active' : 'inactive';
            const libraryId = admin.libraryId._id || admin.libraryId;
            await Library.findByIdAndUpdate(libraryId, { status: libraryStatus });
        }

        res.json({ success: true, message: 'Status updated successfully', data: admin });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.deleteAdmin = async (req, res) => {
    try {
        if (req.params.id === req.user._id.toString()) {
            return res.status(400).json({ message: 'You cannot delete your own account' });
        }
        const admin = await Admin.findByIdAndUpdate(req.params.id, { isDeleted: true });
        if (!admin) return res.status(404).json({ message: 'User not found' });
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

/**
 * 🔹 Change Password (Self)
 */
exports.changePassword = async (req, res) => {
    try {
        const { newPassword } = req.body;
        const id = req.user._id;

        if (!newPassword) {
            return res.status(400).json({ message: 'New password is required' });
        }

        const admin = await Admin.findById(id);
        if (!admin) return res.status(404).json({ message: 'User not found' });

        admin.password = newPassword; // Pre-save hook will hash it
        await admin.save();

        // If it's a Adminith Library table as well (if password is kept there)
        if (admin.userType === 'admin' && admin.libraryId) {
            const libId = admin.libraryId._id || admin.libraryId;
            await Library.findByIdAndUpdate(libId, { password: newPassword });
        }

        res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
        console.error("Change Password Error:", error);
        res.status(500).json({ message: error.message });
    }
};

/**
 * 🔹 Get Admin Dashboard Data
 */
exports.getDashboard = async (req, res) => {
    try {
        const libraryId = req.user.libraryId?._id || req.user.libraryId || req.user._id;

        // Date Boundaries
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const currentMonthStart = new Date();
        currentMonthStart.setDate(1);
        currentMonthStart.setHours(0, 0, 0, 0);

        const currentYearStart = new Date();
        currentYearStart.setMonth(0, 1);
        currentYearStart.setHours(0, 0, 0, 0);

        const next7Days = new Date();
        next7Days.setDate(todayStart.getDate() + 7);

        const next30Days = new Date();
        next30Days.setDate(todayStart.getDate() + 30);

        const startOfMonth = new Date(currentMonthStart);

        const currentYear = new Date().getFullYear();
        const startOfYear = new Date(currentYear, 0, 1);
        const endOfYear = new Date(currentYear, 11, 31, 23, 59, 59, 999);

        // Prepare Attendance Queries for last 7 days
        const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const attendanceQueries = [];
        for (let i = 6; i >= 0; i--) {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() - i);
            targetDate.setHours(0, 0, 0, 0);

            const startOfDay = new Date(targetDate);
            const endOfDay = new Date(targetDate);
            endOfDay.setHours(23, 59, 59, 999);

            attendanceQueries.push(
                Attendance.countDocuments({
                    libraryId,
                    status: 'present',
                    date: { $gte: startOfDay, $lte: endOfDay }
                }).then(present => ({
                    day: daysOfWeek[targetDate.getDay()],
                    present
                }))
            );
        }

        // Execute queries concurrently
        const [
            totalStudents,
            pendingFees,
            activeMemberships,
            expiredMemberships,
            expiringIn7Days,
            todaysAttendance,
            expiringStudents,
            revenueAgg,
            plans,
            activeCampaign,
            libraryObj,
            monthlyRevenueAgg,
            plansList,
            latestStudents,
            latestPayments,
            latestNotices,
            latestAttendance,
            studentsThisMonth,
            expiredThisMonth,
            attendanceCounts
        ] = await Promise.all([
            Student.countDocuments({ libraryId, isDeleted: false }),
            Student.countDocuments({ libraryId, isDeleted: false, paymentStatus: 'pending' }),
            Student.countDocuments({ libraryId, isDeleted: false, planStatus: 'active' }),
            Student.countDocuments({ libraryId, isDeleted: false, planStatus: 'expired' }),
            Student.countDocuments({ 
                libraryId, 
                isDeleted: false, 
                planStatus: 'active',
                expiryDate: { $gte: todayStart, $lte: next7Days }
            }),
            Attendance.countDocuments({
                libraryId,
                date: { $gte: todayStart }
            }),
            Student.find({
                libraryId,
                isDeleted: false,
                planStatus: 'active',
                expiryDate: { $gte: todayStart, $lte: next30Days }
            }).sort({ expiryDate: 1 }).limit(5).select('name expiryDate'),
            Payment.aggregate([
                { $match: { libraryId: new mongoose.Types.ObjectId(libraryId), paymentStatus: 'paid' } },
                { 
                    $group: { 
                        _id: null, 
                        totalRevenue: { $sum: '$amount' },
                        todayRevenue: {
                            $sum: {
                                $cond: [
                                    { $gte: [{ $ifNull: ['$paymentDate', '$createdAt'] }, todayStart] },
                                    '$amount',
                                    0
                                ]
                            }
                        },
                        monthlyRevenue: {
                            $sum: {
                                $cond: [
                                    { $gte: [{ $ifNull: ['$paymentDate', '$createdAt'] }, currentMonthStart] },
                                    '$amount',
                                    0
                                ]
                            }
                        },
                        thisYearRevenue: {
                            $sum: {
                                $cond: [
                                    { $gte: [{ $ifNull: ['$paymentDate', '$createdAt'] }, currentYearStart] },
                                    '$amount',
                                    0
                                ]
                            }
                        }
                    } 
                }
            ]),
            Plan.find({ libraryId, isDeleted: false }).limit(5),
            Notice.findOne({ libraryId, isActive: true }).sort({ createdAt: -1 }),
            Library.findById(libraryId),
            Payment.aggregate([
                { $match: { libraryId: new mongoose.Types.ObjectId(libraryId), paymentStatus: 'paid' } },
                { $project: { amount: 1, date: { $ifNull: ['$paymentDate', '$createdAt'] } } },
                { $match: { date: { $gte: startOfYear, $lte: endOfYear } } },
                { $group: { _id: { $month: '$date' }, revenue: { $sum: '$amount' } } }
            ]),
            Plan.find({ libraryId, isDeleted: false }),
            Student.find({ libraryId, isDeleted: false }).sort({ createdAt: -1 }).limit(5).select('name createdAt'),
            Payment.find({ libraryId, paymentStatus: 'paid' }).sort({ createdAt: -1 }).limit(5).populate('studentId', 'name').populate('planId', 'name'),
            Notice.find({ libraryId, isDeleted: false }).sort({ createdAt: -1 }).limit(5).select('title createdAt'),
            Attendance.find({ libraryId, status: 'present' }).sort({ checkIn: -1 }).limit(5).populate('studentId', 'name'),
            Student.countDocuments({ libraryId, isDeleted: false, createdAt: { $gte: startOfMonth } }),
            Student.countDocuments({ libraryId, isDeleted: false, planStatus: 'expired', updatedAt: { $gte: startOfMonth } }),
            Promise.all(attendanceQueries)
        ]);

        const totalRevenue = revenueAgg.length > 0 ? revenueAgg[0].totalRevenue : 0;
        const todayRevenue = revenueAgg.length > 0 ? revenueAgg[0].todayRevenue : 0;
        const monthlyRevenue = revenueAgg.length > 0 ? revenueAgg[0].monthlyRevenue : 0;
        const thisYearRevenue = revenueAgg.length > 0 ? revenueAgg[0].thisYearRevenue : 0;

        const libraryName = libraryObj ? libraryObj.name : '';

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const revenueData = monthNames.map((name, index) => {
            const match = monthlyRevenueAgg.find(m => m._id === (index + 1));
            return {
                month: name,
                revenue: match ? match.revenue : 0
            };
        });

        // Compute Plan Distribution
        const planData = await Promise.all(plansList.map(async (plan) => {
            const activeCount = await Student.countDocuments({
                libraryId,
                planId: plan._id,
                planStatus: 'active',
                isDeleted: false
            });
            return {
                name: plan.name,
                value: activeCount
            };
        }));

        // Process Attendance Data
        const attendanceData = attendanceCounts.map(item => ({
            day: item.day,
            present: item.present,
            absent: Math.max(0, totalStudents - item.present)
        }));

        const activitiesList = [];

        latestStudents.forEach(item => {
            activitiesList.push({
                id: `reg_${item._id}`,
                text: `New student ${item.name} registered`,
                time: item.createdAt,
                type: 'registration'
            });
        });

        latestPayments.forEach(item => {
            const name = item.studentId?.name || 'Unknown Student';
            const plan = item.planId?.name || 'Plan';
            activitiesList.push({
                id: `pay_${item._id}`,
                text: `Payment of ₹${item.amount} received from ${name} for ${plan}`,
                time: item.createdAt,
                type: 'payment'
            });
        });

        latestNotices.forEach(item => {
            activitiesList.push({
                id: `not_${item._id}`,
                text: `Library notice published: ${item.title}`,
                time: item.createdAt,
                type: 'notice'
            });
        });

        latestAttendance.forEach(item => {
            const name = item.studentId?.name || 'Unknown Student';
            activitiesList.push({
                id: `att_${item._id}`,
                text: `${name} marked present`,
                time: item.checkIn,
                type: 'attendance'
            });
        });

        activitiesList.sort((a, b) => new Date(b.time) - new Date(a.time));
        const recentActivities = activitiesList.slice(0, 5);

        res.json({
            success: true,
            data: {
                totalStudents,
                pendingFees,
                activeMemberships,
                expiredMemberships,
                expiringIn7Days,
                todaysAttendance,
                totalRevenue,
                todayRevenue,
                monthlyRevenue,
                thisYearRevenue,
                expiringStudents,
                plans,
                activeCampaign,

                // Extra fields for web integration
                libraryName,
                revenueData,
                planData,
                attendanceData,
                recentActivities,
                studentsThisMonth,
                expiredThisMonth
            }
        });
    } catch (error) {
        console.error("Get Admin Dashboard Error:", error);
        res.status(500).json({ message: error.message });
    }
};
