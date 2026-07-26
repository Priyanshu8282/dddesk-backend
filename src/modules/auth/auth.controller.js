const mongoose = require('mongoose');
const Admin = require('../admins/admin.model');
const Student = require('../students/student.model');
const Role = require('../roles/role.model');
const Library = require('../libraries/library.model');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const config = require('../../config/config');

exports.login = async (req, res) => {
    console.log("[BACKEND] login request received:", req.body);
    try {
        const { identifier, email, mobile, password, userRole, fcmToken } = req.body;
        const role = userRole === 'STUDENT' ? 'STUDENT' : 'ADMIN';
        const Model = role === 'ADMIN' ? Admin : Student;

        // Determine what was provided
        const loginEmail = email || (identifier && identifier.includes('@') ? identifier : "");
        const loginMobile = mobile || (identifier && !identifier.includes('@') ? identifier : "");

        let query = {};
        if (loginEmail && loginMobile) {
            query = { $or: [{ email: loginEmail }, { mobile: loginMobile }] };
        } else if (loginEmail) {
            query = { email: loginEmail };
        } else if (loginMobile) {
            query = { mobile: loginMobile };
        } else {
            return res.status(400).json({ success: false, message: 'Email or Mobile is required' });
        }

        const user = await Model.findOne({ ...query, isDeleted: { $ne: true } })
            .populate(role === 'ADMIN' ? {
                path: 'roleId',
                populate: { path: 'permissionIds' }
            } : 'libraryId');

        if (!user) {
            let errorMsg = 'User not found';
            if (loginMobile && !loginEmail) errorMsg = 'Mobile number not found';
            else if (loginEmail && !loginMobile) errorMsg = 'Email address not found';
            return res.status(401).json({ success: false, message: errorMsg });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Incorrect password' });
        }

        if (role === 'STUDENT' && user.status !== 'active') {
            return res.status(403).json({ success: false, message: 'Account is inactive' });
        }

        console.log("[BACKEND] Processing FCM token in login. fcmToken from req.body:", fcmToken);
        if (fcmToken) {
            if (!user.fcmTokens) user.fcmTokens = [];
            if (!user.fcmTokens.includes(fcmToken)) {
                console.log(`[BACKEND] Pushing new FCM token: ${fcmToken}`);
                user.fcmTokens.push(fcmToken);
                user.markModified('fcmTokens');
                await user.save();
                console.log(`[BACKEND] Successfully saved user with new FCM token. Current tokens:`, user.fcmTokens);
            } else {
                console.log(`[BACKEND] FCM token already exists for user.`);
            }
        } else {
            console.log(`[BACKEND] No FCM token provided in login request body.`);
        }

        const permissions = user.roleId?.permissionIds?.map(p => p.key) || [];

        const token = jwt.sign(
            { id: user._id, email: user.email, type: role === 'ADMIN' ? (user.userType || 'admin') : 'student' },
            config.jwt.secret || 'secret_key',
            { expiresIn: config.jwt.expiration }
        );

        const userData = {
            id: user._id,
            name: user.name,
            email: user.email,
            mobile: user.mobile,
            profileImage: user.profileImage,
            userType: role === 'ADMIN' ? (user.userType || 'admin') : 'student',
            permissions,
            fcmTokens: user.fcmTokens || []
        };

        if (role === 'ADMIN') {
            userData.role = user.roleId?.name;
            userData.libraryId = user.libraryId;
        } else {
            userData.libraryId = user.libraryId?._id || user.libraryId;
        }

        res.json({
            success: true,
            token,
            user: userData,
            [role.toLowerCase()]: userData // For compatibility with existing frontend
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.sendOTP = async (req, res) => {
    try {
        const { mobile, userRole } = req.body;
        const role = userRole === 'STUDENT' ? 'STUDENT' : 'ADMIN';
        const Model = role === 'ADMIN' ? Admin : Student;

        let user = await Model.findOne({ mobile });
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        if (!user) {
            return res.status(404).json({ success: false, message: 'Mobile number not found' });
        } else {
            user.otp = otp;
            await user.save();
        }

        console.log(`[OTP] Sent to ${mobile} (${role}): ${otp}`);
        res.json({ 
            success: true, 
            message: 'OTP sent successfully', 
            otp, // Only for development
            isOTP: true 
        });
    } catch (error) {
        console.error("[AUTH] sendOTP Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.verifyOTP = async (req, res) => {
    try {
        const { mobile, otp, userRole, fcmToken } = req.body;
        const role = userRole === 'STUDENT' ? 'STUDENT' : 'ADMIN';
        const Model = role === 'ADMIN' ? Admin : Student;

        const user = await Model.findOne({ mobile }).populate(role === 'ADMIN' ? {
            path: 'roleId',
            populate: { path: 'permissionIds' }
        } : 'libraryId');

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.otp !== otp) {
            return res.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        // Clear OTP
        user.otp = null;
        if (role === 'STUDENT') user.lastLogin = new Date();
        
        console.log("[BACKEND] Processing FCM token in verifyOTP. fcmToken from req.body:", fcmToken);
        if (fcmToken) {
            if (!user.fcmTokens) user.fcmTokens = [];
            if (!user.fcmTokens.includes(fcmToken)) {
                console.log(`[BACKEND] Pushing new FCM token: ${fcmToken}`);
                user.fcmTokens.push(fcmToken);
                user.markModified('fcmTokens');
            } else {
                console.log(`[BACKEND] FCM token already exists for user.`);
            }
        } else {
            console.log(`[BACKEND] No FCM token provided in verifyOTP request body.`);
        }
        await user.save();
        console.log(`[BACKEND] Successfully saved user after verifyOTP. Current tokens:`, user.fcmTokens);

        const token = jwt.sign(
            { id: user._id, type: role === 'ADMIN' ? (user.userType || 'admin') : 'student', libraryId: user.libraryId?._id || user.libraryId },
            config.jwt.secret || 'secret_key',
            { expiresIn: config.jwt.expiration }
        );

        const permissions = user.roleId?.permissionIds?.map(p => p.key) || [];

        const userData = {
            id: user._id,
            name: user.name,
            email: user.email,
            mobile: user.mobile,
            profileImage: user.profileImage,
            userType: role === 'ADMIN' ? (user.userType || 'admin') : 'student',
            permissions,
            fcmTokens: user.fcmTokens || []
        };

        if (role === 'ADMIN') {
            userData.role = user.roleId?.name;
            userData.libraryId = user.libraryId;
        } else {
            userData.libraryId = user.libraryId?._id || user.libraryId;
        }

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: userData,
            [role.toLowerCase()]: userData
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Removed vendor functions
exports.getMe = async (req, res) => {
    try {
        const user = req.user;
        const userType = req.userType;
        res.json({
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.roleId?.name,
            libraryId: user.libraryId?._id || user.libraryId,
            profileImage: user.profileImage,
            userType: userType,
            status: user.status,
            permissions: req.permissions
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const { name, ownerName, currentPassword, newPassword } = req.body || {};

        const Model = Admin;
        const user = await Model.findById(req.user._id);

        if (name) user.name = name;

        if (req.file) {
            if (user.profileImage) {
                const oldPath = path.join(__dirname, '../../../', user.profileImage);
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            }
            user.profileImage = `uploads/profiles/${req.file.filename}`;
        }

        if (newPassword) {
            user.password = await bcrypt.hash(newPassword, 10);
        }

        await user.save();

        res.json({
            message: 'Profile updated successfully',
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                profileImage: user.profileImage,
                userType: req.user.userType,
                status: user.status
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.deleteProfileImage = async (req, res) => {
    try {
        const Model = Admin;
        const user = await Model.findById(req.user._id);

        if (user.profileImage) {
            const imagePath = path.join(__dirname, '../../../', user.profileImage);
            if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
            user.profileImage = null;
            await user.save();
        }
        res.json({ message: 'Profile image deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getPublicProfileImage = async (req, res) => {
    try {
        const id = req.params.id;
        const field = req.query.field;
        const index = req.query.index;
        const defaultPath = path.join(__dirname, '../../../uploads/profiles/default-avatar.png');

        const sendFallbackOr404 = (name = 'User') => {
            if (fs.existsSync(defaultPath)) {
                return res.sendFile(defaultPath);
            }
            return res.redirect(`https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=4f46e5&color=fff&size=256&bold=true`);
        };

        // 1. Handle explicit 'default' request
        if (id === 'default') {
            return sendFallbackOr404('Admin');
        }

        // 2. Validate ObjectId to prevent CastError
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return sendFallbackOr404('Admin');
        }

        // 3. Handle Library Image Fields (logo, photos)
        if (field === 'logo' || field === 'photos') {
            let library = await Library.findById(id);
            if (!library) {
                const adminUser = await Admin.findById(id);
                if (adminUser && adminUser.libraryId) {
                    library = await Library.findById(adminUser.libraryId);
                }
            }
            if (!library) return sendFallbackOr404('Library');
            
            let targetImage = null;
            if (field === 'logo') {
                targetImage = library.logo;
            } else if (field === 'photos' && index !== undefined) {
                targetImage = library.photos[parseInt(index)];
            }
            
            if (!targetImage) return sendFallbackOr404(library.name || 'Library');
            
            const imagePath = path.resolve(process.cwd(), targetImage);
            if (fs.existsSync(imagePath)) {
                return res.sendFile(imagePath, (err) => {
                    if (err && !res.headersSent) {
                        return sendFallbackOr404(library.name || 'Library');
                    }
                });
            }
            return sendFallbackOr404(library.name || 'Library');
        }

        // 4. Default Handle Admin Profile Image
        let user = await Admin.findById(id);

        if (!user || !user.profileImage || user.profileImage.includes('default-avatar.png')) {
            return sendFallbackOr404(user?.name || 'Admin');
        }

        const imagePath = path.resolve(process.cwd(), user.profileImage);
        if (fs.existsSync(imagePath)) {
            return res.sendFile(imagePath, (err) => {
                if (err && !res.headersSent) {
                    return sendFallbackOr404(user?.name || 'Admin');
                }
            });
        } else {
            return sendFallbackOr404(user?.name || 'Admin');
        }
    } catch (error) {
        return res.redirect(`https://ui-avatars.com/api/?name=User&background=4f46e5&color=fff&size=256&bold=true`);
    }
};

exports.updateFcmToken = async (req, res) => {
    try {
        const { fcmToken } = req.body;
        if (!fcmToken) return res.status(400).json({ success: false, message: 'FCM Token is required' });

        const isStudent = req.user.userType === 'student';
        const Model = isStudent ? Student : Admin;
        
        const user = await Model.findById(req.user._id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (!user.fcmTokens) user.fcmTokens = [];
        if (!user.fcmTokens.includes(fcmToken)) {
            user.fcmTokens.push(fcmToken);
            await user.save();
        }

        res.json({ success: true, message: 'FCM Token updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

        let user = await Student.findOne({ email });
        let role = 'STUDENT';
        if (!user) {
            user = await Admin.findOne({ email });
            role = 'ADMIN';
        }

        if (!user) {
            return res.status(404).json({ success: false, message: 'No account found with that email' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otp = otp;
        await user.save();

        console.log(`[AUTH] Forgot Password OTP sent to ${email} (${role}): ${otp}`);
        
        // In a real app, send the email here using an email service
        res.json({
            success: true,
            message: 'OTP sent to your email successfully',
            otp, // Only for development/testing
            isOTP: true
        });

    } catch (error) {
        console.error("[AUTH] forgotPassword Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.verifyResetOTP = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and OTP are required' });

        let user = await Student.findOne({ email });
        if (!user) user = await Admin.findOne({ email });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.otp !== otp) {
            return res.status(400).json({ success: false, message: 'Invalid OTP' });
        }

        res.json({
            success: true,
            message: 'OTP verified successfully'
        });

    } catch (error) {
        console.error("[AUTH] verifyResetOTP Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !otp || !newPassword) {
            return res.status(400).json({ success: false, message: 'Email, OTP, and New Password are required' });
        }

        let user = await Student.findOne({ email });
        if (!user) user = await Admin.findOne({ email });

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (user.otp !== otp) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }

        user.password = newPassword; // Pre-save hook will hash this
        user.otp = null; // Clear the OTP after successful reset
        await user.save();

        console.log(`[AUTH] Password reset successfully for ${email}`);

        res.json({
            success: true,
            message: 'Password reset successfully'
        });

    } catch (error) {
        console.error("[AUTH] resetPassword Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};
