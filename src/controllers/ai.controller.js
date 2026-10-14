const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/ApiError');
const audit = require('../utils/audit');
const { tenantId } = require('../middlewares/access.middleware');
const { oid } = require('../services/reportQuery');
const aiService = require('../services/ai.service');

// Tenant as ObjectId. Only superadmin may target another library; everyone else is pinned to req.libraryId.
const scope = (req) => {
    const id = tenantId(req);
    if (!id) throw new ApiError(400, 'Library context required for assistant requests');
    return oid(id);
};

const ok = (res, data, message) => res.status(200).json({ success: true, message, data });

exports.queryAssistant = catchAsync(async (req, res) => {
    const result = await aiService.processQuery(scope(req), req.user._id, req.body.prompt);
    ok(res, result, 'AI response generated successfully');
});

exports.getInsights = catchAsync(async (req, res) => {
    ok(res, await aiService.generateInsights(scope(req)), 'Daily business insights generated successfully');
});

exports.getQuickPrompts = catchAsync(async (req, res) => {
    ok(res, aiService.getQuickPrompts(), 'Quick prompts retrieved successfully');
});

exports.getChatHistory = catchAsync(async (req, res) => {
    ok(res, await aiService.getChatHistory(scope(req), req.user._id, req.query.limit), 'Chat history retrieved successfully');
});

exports.clearChatHistory = catchAsync(async (req, res) => {
    await aiService.clearChatHistory(scope(req), req.user._id);
    res.status(200).json({ success: true, message: 'Conversation history cleared successfully' });
});

// Explicit confirmation of a previously proposed action (nothing runs without this call)
exports.confirmAction = catchAsync(async (req, res) => {
    const L = scope(req);
    const result = await aiService.confirmAction(L, req.user._id, req.body.token, req);
    audit(req, `ai.action.${result.type.toLowerCase()}`, 'AiChat', result.chatId, result.result);
    ok(res, result, 'Action completed');
});

exports.cancelAction = catchAsync(async (req, res) => {
    ok(res, await aiService.cancelAction(scope(req), req.user._id, req.body.token), 'Action cancelled');
});
