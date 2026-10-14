const mongoose = require('mongoose');
require('dotenv').config();
mongoose.connect(process.env.MONGODB_URL).then(async () => {
    const Story = require('./src/models/story.model');
    await Story.updateMany({}, { $set: { views: 0, uniqueViews: 0, viewedBy: [] } });
    console.log('Reset views successfully.');
    process.exit(0);
}).catch(console.error);
