const path = require('node:path');
const { pathToFileURL } = require('node:url');

import(pathToFileURL(path.join(__dirname, '../mcp/http.mjs')).href).catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
