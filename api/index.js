const app = require("../src/app");
const connectDB = require("../src/config/database");

module.exports = async (req, res) => {
    await connectDB();
    await require('../src/services/platformSettings.service').ensureFresh();
    return app(req, res);
};
