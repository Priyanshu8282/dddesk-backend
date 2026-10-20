const mongoose = require("mongoose");
const config = require("./config");

let isConnected = false;

const connectDB = async () => {
    if (isConnected || mongoose.connection.readyState === 1) {
        isConnected = true;
        return;
    }

    try {
        const db = await mongoose.connect(config.mongoose.url, {
            family: 4,                  // skip slow IPv6 attempts (common cause of slow Atlas connections on Windows)
            minPoolSize: Number(process.env.DB_MIN_POOL || 5),   // keep connections open: a new one costs seconds on a distant cluster
            maxPoolSize: Number(process.env.DB_MAX_POOL || 20),
            compressors: ['zlib'],      // smaller payloads over a slow link
            serverSelectionTimeoutMS: 20000,
            socketTimeoutMS: 60000,
        });
        isConnected = db.connections[0].readyState === 1;
        console.log("Connected to MongoDB Atlas");
    } catch (e) {
        console.error("Failed to connect to DB:", e.message);
    }
};

module.exports = connectDB;
