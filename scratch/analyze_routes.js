const fs = require('fs');
const path = require('path');

function inspectRouter(filePath, baseMount) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const endpoints = [];

  // Look for router.get, router.post, router.put, router.patch, router.delete
  const routeRegex = /router\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const subPath = match[2];
    const fullPath = (baseMount + (subPath === '/' ? '' : subPath)).replace(/\/+/g, '/');
    endpoints.push({ method, path: fullPath, file: path.basename(filePath) });
  }
  return endpoints;
}

console.log('--- Analyzing Route Modules ---');

// Public routes
const publicDir = path.resolve('c:/Users/piyus/OneDrive/Desktop/DDdesk/backend/src/routes/public');
const publicIndex = fs.readFileSync(path.join(publicDir, 'index.js'), 'utf8');
console.log('Public mounts in index.js:');
// Public mounts:
// router.use('/', authRoutes) -> /v1/public/...
// router.use('/website', websiteRoutes) -> /v1/public/website/...

const publicEndpoints = [
  ...inspectRouter(path.join(publicDir, 'auth.routes.js'), '/v1/public'),
  ...inspectRouter(path.join(publicDir, 'website.routes.js'), '/v1/public/website')
];

// Private routes
const privateDir = path.resolve('c:/Users/piyus/OneDrive/Desktop/DDdesk/backend/src/routes/private');
const privateIndex = fs.readFileSync(path.join(privateDir, 'index.js'), 'utf8');

// Parse router.use('/path', subRouter)
const useRegex = /router\.use\s*\(\s*['"]([^'"]+)['"]\s*,\s*([a-zA-Z0-9]+)\s*\)/g;
let uMatch;
const mountMap = {};
while ((uMatch = useRegex.exec(privateIndex)) !== null) {
  const mount = uMatch[1];
  const varName = uMatch[2];
  mountMap[varName] = mount;
}

// Find require statements in privateIndex to map varName to fileName
const reqRegex = /(?:const|let|var)\s+([a-zA-Z0-9]+)\s*=\s*require\s*\(\s*['"]\.\/([^'"]+)['"]\s*\)/g;
let rMatch;
const fileMap = {};
while ((rMatch = reqRegex.exec(privateIndex)) !== null) {
  fileMap[rMatch[1]] = rMatch[2].endsWith('.js') ? rMatch[2] : rMatch[2] + '.js';
}

console.log('Private Mounts:');
const privateEndpoints = [];
for (const [varName, mount] of Object.entries(mountMap)) {
  const fileName = fileMap[varName];
  if (fileName) {
    const fullFilePath = path.join(privateDir, fileName);
    if (fs.existsSync(fullFilePath)) {
      const eps = inspectRouter(fullFilePath, '/v1/private' + (mount === '/' ? '' : mount));
      privateEndpoints.push({
        module: varName.replace('Routes', ''),
        mount: '/v1/private' + mount,
        fileName,
        endpoints: eps
      });
    }
  }
}

console.log(`\nFound ${publicEndpoints.length} Public Endpoints:`);
publicEndpoints.forEach(e => console.log(`  ${e.method.padEnd(7)} ${e.path}`));

console.log(`\nFound Private Modules (${privateEndpoints.length} modules):`);
let totalPrivate = 0;
for (const pm of privateEndpoints) {
  totalPrivate += pm.endpoints.length;
  console.log(`\n--- Module: ${pm.module.toUpperCase()} (Mount: ${pm.mount}, File: ${pm.fileName}, ${pm.endpoints.length} APIs) ---`);
  pm.endpoints.forEach(e => console.log(`  ${e.method.padEnd(7)} ${e.path}`));
}

console.log(`\nTOTAL APIS: Public = ${publicEndpoints.length}, Private = ${totalPrivate}, Grand Total = ${publicEndpoints.length + totalPrivate}`);
