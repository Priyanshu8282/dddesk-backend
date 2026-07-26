const mongoose = require("mongoose");
const config = require("./config");

let isConnected = false;

const connectDB = async () => {
    if (isConnected || mongoose.connection.readyState === 1) {
        isConnected = true;
        return;
    }

    try {
        const db = await mongoose.connect(config.mongoose.url);
        isConnected = db.connections[0].readyState === 1;
        console.log("Connected to MongoDB Atlas");
    } catch (e) {
        console.error("Failed to connect to DB:", e.message);
    }
};

module.exports = connectDB;
