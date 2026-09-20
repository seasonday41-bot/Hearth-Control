import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const sources = [
  {
    name: 'HearthXauBridge.mq5',
    path: path.resolve('mql5/HearthXauBridge.mq5'),
    role: 'market_only_v1',
  },
  {
    name: 'HearthXauBridgeV2.mq5',
    path: path.resolve('mql5/HearthXauBridgeV2.mq5'),
    role: 'market_plus_read_only_demo_risk_telemetry',
  },
  {
    name: 'HearthXauDemoExecutorV3.mq5',
    path: path.resolve('mql5/HearthXauDemoExecutorV3.mq5'),
    role: 'demo_only_execution_plus_market_and_risk_telemetry',
  },
];
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

const missingSources = sources.filter((item) => !fs.existsSync(item.path));
if (missingSources.length > 0) {
  console.error(JSON.stringify({
    ok: false,
    error: 'mt5_ea_source_missing',
    missing_sources: missingSources,
  }));
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
  for (const source of sources) {
    const destination = path.join(expertsDir, source.name);
    if (fs.existsSync(destination)) {
      if (!sameFile(source.path, destination)) {
        results.push({
          experts_dir: expertsDir,
          source: source.path,
          role: source.role,
          status: 'conflict',
          destination,
        });
        continue;
      }
      results.push({
        experts_dir: expertsDir,
        source: source.path,
        role: source.role,
        status: 'already_installed',
        destination,
      });
      continue;
    }

    fs.copyFileSync(source.path, destination, fs.constants.COPYFILE_EXCL);
    results.push({
      experts_dir: expertsDir,
      source: source.path,
      role: source.role,
      status: 'installed',
      destination,
    });
  }
}

const conflicts = results.filter((item) => item.status === 'conflict');
console.log(JSON.stringify({
  ok: conflicts.length === 0,
  sources,
  results,
  manual_steps: [
    'Open MetaEditor and compile HearthXauDemoExecutorV3.mq5 for DEMO_AUTO execution, or HearthXauBridgeV2.mq5 for read-only Invest V2 telemetry.',
    'In MetaTrader 5 Desktop: Tools > Options > Expert Advisors, add 127.0.0.1 to allowed addresses.',
    'Open your broker XAUUSD/Gold chart and attach exactly one HearthXauDemoExecutorV3 for demo execution; use HearthXauBridgeV2 when you want read-only telemetry only.',
    'Use HearthXauBridge.mq5 only when you want the original market-only V1 behavior.',
    'Keep Hearth Control running; the V2 EA pushes market bars plus read-only demo risk telemetry to TCP 127.0.0.1:8766.',
  ],
}, null, 2));

if (conflicts.length > 0) process.exit(4);
