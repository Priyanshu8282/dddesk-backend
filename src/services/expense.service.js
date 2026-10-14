const Expense = require('../models/expense.model');

exports.createExpense = async (data) => Expense.create(data);

exports.listExpenses = async (libraryId, query) => {
  const filter = { libraryId };
  if (query.category) filter.category = query.category;
  if (query.from || query.to) {
    filter.date = {};
    if (query.from) filter.date.$gte = new Date(query.from);
    if (query.to)   filter.date.$lte = new Date(query.to);
  }
  const page  = parseInt(query.page)  || 1;
  const limit = parseInt(query.limit) || 20;
  const skip  = (page - 1) * limit;
  const [data, total, sumResult] = await Promise.all([
    Expense.find(filter).sort({ date: -1 }).skip(skip).limit(limit).populate('createdBy', 'name'),
    Expense.countDocuments(filter),
    Expense.aggregate([
      { $match: { ...filter, isDeleted: false } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);
  return { data, total, page, totalPages: Math.ceil(total / limit), totalAmount: sumResult[0]?.total || 0 };
};

exports.getExpense = async (id, libraryId) =>
  Expense.findOne({ _id: id, libraryId });

exports.updateExpense = async (id, libraryId, body) =>
  Expense.findOneAndUpdate({ _id: id, libraryId }, { $set: body }, { new: true });

exports.deleteExpense = async (id, libraryId) =>
  Expense.findOneAndUpdate({ _id: id, libraryId }, { $set: { isDeleted: true } });
