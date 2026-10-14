const express = require('express');
const path = require('path');

// Load environment variables so models/services don't fail
require('dotenv').config({ path: path.resolve('c:/Users/piyus/OneDrive/Desktop/DDdesk/backend/.env') });

const app = require('c:/Users/piyus/OneDrive/Desktop/DDdesk/backend/src/app');

function printRoutes(app) {
  const routes = [];

  function split(thing) {
    if (typeof thing === 'string') {
      return thing.split('/');
    } else if (thing.fast_slash) {
      return '';
    } else {
      var match = thing.toString()
        .replace('\\/?', '')
        .replace('(?=\\/|$)', '$')
        .match(/^\/\^((?:\\[\/\\#\\?\\$]|[^\\/\\#\\?\\$])*)\$\//);
      return match
        ? match[1].replace(/\\(.)/g, '$1').split('/')
        : '<complex:' + thing.toString() + '>';
    }
  }

  function getRoutes(stack, prefix = '') {
    stack.forEach(middleware => {
      if (middleware.route) {
        // routes registered directly on the app
        const methods = Object.keys(middleware.route.methods).map(m => m.toUpperCase()).join(', ');
        routes.push({
          method: methods,
          path: prefix + (middleware.route.path === '/' ? '' : middleware.route.path)
        });
      } else if (middleware.name === 'router' || middleware.handle?.stack) {
        // router middleware
        let routePrefix = '';
        if (middleware.regexp) {
          const match = middleware.regexp.source
            .replace('^\\', '')
            .replace('\\/?(?=\\/|$)', '')
            .replace('(?=\\/|$)', '')
            .replace('^', '')
            .replace('\\/', '/')
            .replace('/?(?=/|$)', '');
          // cleanup regex artifacts
          routePrefix = match.replace(/\\\//g, '/').replace(/\$$/, '').replace(/\/\?$/, '');
          if (!routePrefix.startsWith('/')) routePrefix = '/' + routePrefix;
          // Clean up Express internal patterns
          routePrefix = routePrefix.replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
        }
        getRoutes(middleware.handle.stack, prefix + (routePrefix === '/' ? '' : routePrefix));
      }
    });
  }

  if (app._router && app._router.stack) {
    getRoutes(app._router.stack);
  }

  return routes;
}

const list = printRoutes(app);
console.log(`Total mounted endpoints: ${list.length}\n`);

// Group by prefix
const groups = {};
for (const r of list) {
  const parts = r.path.split('/').filter(Boolean);
  const groupName = parts.slice(0, 3).join('/') || 'root';
  if (!groups[groupName]) groups[groupName] = [];
  groups[groupName].push(r);
}

for (const [group, endpoints] of Object.entries(groups)) {
  console.log(`=== ${group} (${endpoints.length} APIs) ===`);
  for (const ep of endpoints) {
    console.log(`  ${ep.method.padEnd(7)} ${ep.path}`);
  }
  console.log();
}
