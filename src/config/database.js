const mongoose = require("mongoose");
const config = require("./config");

const connectDB = () => {
    return mongoose.connect(config.mongoose.url)
        .then(() => console.log("Connected to DB at", config.mongoose.url))
        .catch((e) => console.log("Failed to connect to DB", e));
}

module.exports = connectDB;
