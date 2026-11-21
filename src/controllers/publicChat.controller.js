const catchAsync = require('../utils/catchAsync');
const svc = require('../services/publicChat.service');

exports.chat = catchAsync(async (req, res) => {
    const { message, history } = req.body;
    const { reply, engine } = await svc.reply(message, history);
    res.status(200).json({ success: true, data: { reply, engine } });
});
