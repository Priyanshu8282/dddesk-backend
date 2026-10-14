const Admin = require('./admin.model');
const Attendance = require('./attendance.model');
const AttendanceQR = require('./attendanceQR.model');
const DailyCode = require('./dailyCode.model');
const AuditLog = require('./auditLog.model');
const Banner = require('./banner.model');
const Branch = require('./branch.model');
const Enquiry = require('./enquiry.model');
const Expense = require('./expense.model');
const Library = require('./library.model');
const LibraryWebsite = require('./libraryWebsite.model');
const Notice = require('./notice.model');
const Notification = require('./notification.model');
const Payment = require('./payment.model');
const Permission = require('./permission.model');
const Plan = require('./plan.model');
const PlatformPlan = require('./platformPlan.model');
const Role = require('./role.model');
const Seat = require('./seat.model');
const Setting = require('./setting.model');
const SidebarMenu = require('./sidebar.model');
const Story = require('./story.model');
const Student = require('./student.model');
const Complaint = require('./complaint.model');
const Coupon = require('./coupon.model');
const Review = require('./review.model');
const AiChat = require('./aiChat.model');

module.exports = {
    // Primary exports
    Admin,
    Attendance,
    AttendanceQR,
    DailyCode,
    AuditLog,
    Banner,
    Branch,
    Enquiry,
    Expense,
    Library,
    LibraryWebsite,
    Notice,
    Notification,
    Payment,
    Permission,
    Plan,
    PlatformPlan,
    Role,
    Seat,
    Setting,
    SidebarMenu,
    Story,
    Student,
    Complaint,
    Coupon,
    Review,
    AiChat,

    // Aliases for backward compatibility
    Admins: Admin,
    adminRoles: Role,
};
