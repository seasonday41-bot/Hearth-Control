import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const source = path.resolve('mql5/HearthXauBridge.mq5');
const mobileBundle = '/Applications/MetaTrader 5.app/Wrapper/MetaTrader5Terminal.app';
const officialInstaller =
  'https://download.terminal.free/cdn/web/metaquotes.ltd/mt5/MetaTrader5.pkg.zip';

const candidateRoots = [
  path.join(home, 'Library', 'Application Support', 'net.metaquotes.wine.metatrader5'),
  path.join(home, 'Library', 'Application Support', 'MetaTrader 5'),
];

const sameFile = (left, right) => {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
};

const walk = (root, maxDepth = 10) => {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const normalized = dir.replaceAll('\\', '/');
    if (normalized.endsWith('/MQL5/Experts')) found.push(dir);

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return found;
};

if (!fs.existsSync(source)) {
  console.error(JSON.stringify({ ok: false, error: 'mt5_ea_source_missing', source }));
  process.exit(2);
}

const expertsDirs = [...new Set(candidateRoots.flatMap((root) => walk(root)))];

if (expertsDirs.length === 0) {
  const mobileAppDetected = fs.existsSync(mobileBundle);
  console.log(JSON.stringify({
    ok: false,
    error: mobileAppDetected
      ? 'mt5_mobile_app_only'
      : 'mt5_desktop_not_installed_or_data_folder_not_found',
    mobile_app_detected: mobileAppDetected,
    mobile_bundle: mobileAppDetected ? mobileBundle : null,
    searched_roots: candidateRoots,
    official_desktop_installer: officialInstaller,
    next: mobileAppDetected
      ? [
          'The installed App Store build is the iPhone/iPad MT5 app and cannot host MQL5 Expert Advisors.',
          'Install the official MetaTrader 5 Desktop macOS package from MetaQuotes.',
          'Launch MetaTrader 5 Desktop once so its Wine data directory is created.',
          'Then rerun: npm run mt5:setup',
        ]
      : [
          'Install and launch MetaTrader 5 Desktop for macOS once.',
          'Then rerun: npm run mt5:setup',
        ],
  }, null, 2));
  process.exit(3);
}

const results = [];
for (const expertsDir of expertsDirs) {
  const destination = path.join(expertsDir, 'HearthXauBridge.mq5');
  if (fs.existsSync(destination)) {
    if (!sameFile(source, destination)) {
      results.push({
        experts_dir: expertsDir,
        status: 'conflict',
        destination,
      });
      continue;
    }
    results.push({
      experts_dir: expertsDir,
      status: 'already_installed',
      destination,
    });
    continue;
  }

  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  results.push({
    experts_dir: expertsDir,
    status: 'installed',
    destination,
  });
}

const conflicts = results.filter((item) => item.status === 'conflict');
console.log(JSON.stringify({
  ok: conflicts.length === 0,
  source,
  results,
  manual_steps: [
    'Open MetaEditor and compile HearthXauBridge.mq5.',
    'In MetaTrader 5 Desktop: Tools > Options > Expert Advisors, add 127.0.0.1 to allowed addresses.',
    'Open your broker XAUUSD/Gold chart and attach HearthXauBridge.',
    'Keep Hearth Control running; the EA pushes read-only market bars to TCP 127.0.0.1:8766.',
  ],
}, null, 2));

if (conflicts.length > 0) process.exit(4);
