const authValidation = require('./auth.validation');
const studentValidation = require('./student.validation');
const seatValidation = require('./seat.validation');
const planValidation = require('./plan.validation');
const paymentValidation = require('./payment.validation');
const attendanceValidation = require('./attendance.validation');
const enquiryValidation = require('./enquiry.validation');
const noticeValidation = require('./notice.validation');
const storyValidation = require('./story.validation');
const bannerValidation = require('./banner.validation');
const expenseValidation = require('./expense.validation');
const branchValidation = require('./branch.validation');

module.exports = {
    authValidation,
    studentValidation,
    seatValidation,
    planValidation,
    paymentValidation,
    attendanceValidation,
    enquiryValidation,
    noticeValidation,
    storyValidation,
    bannerValidation,
    expenseValidation,
    branchValidation
};
