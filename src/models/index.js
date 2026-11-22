const fs = require('fs');
const path = require('path');

const models = {};
const files = fs.readdirSync(__dirname);
for (const file of files) {
  if (file === 'index.js' || !file.endsWith('.model.js')) continue;
  const base = file.replace('.model.js', '');
  const key = base.charAt(0).toUpperCase() + base.slice(1);
  try {
    models[key] = require(path.join(__dirname, file));
  } catch (_) {
    // lazy load if needed
  }
}

module.exports = models;
