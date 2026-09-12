const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const packageJson = require('../package.json');

const builtAt = new Date().toISOString();
const buildId = `${packageJson.version}-${builtAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
const metadata = { version: packageJson.version, buildId, builtAt, platform: process.platform, arch: process.arch };
fs.writeFileSync(path.join(__dirname, '../electron/build-meta.json'), `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`Build metadata: ${metadata.buildId}\n`);
