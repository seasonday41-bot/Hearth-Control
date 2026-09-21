const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const stablePath = path.join(root, 'electron/stable-build-meta.json');
const targetPath = path.join(root, 'electron/build-meta.json');
const stable = JSON.parse(fs.readFileSync(stablePath, 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (stable.version !== packageJson.version) throw new Error(`Stable metadata version ${stable.version} does not match package version ${packageJson.version}`);
if (!/^0\.4\.15-\d{14}-[0-9a-f]{6}$/.test(stable.buildId)) throw new Error('Stable metadata build ID is invalid');
fs.writeFileSync(targetPath, `${JSON.stringify(stable, null, 2)}\n`);
process.stdout.write(`Restored stable build metadata: ${stable.buildId}\n`);
