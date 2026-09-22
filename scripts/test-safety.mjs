/**
 * Hearth Safety & Reliability Test Suite
 * Tests security rules added in the safety pass.
 * Run: node scripts/test-safety.mjs (while MCP HTTP server is running on port 3001)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';

const WORKSPACE = process.env.HEARTH_WORKSPACE || process.cwd();
let serverProc = null;
let endpointUrl = process.env.HEARTH_MCP_URL;

const getFreePort = async (startPort = 3005) => {
  for (let p = startPort; p < startPort + 50; p++) {
    const free = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => {
        s.close(() => resolve(true));
      });
    });
    if (free) return p;
  }
  return startPort;
};

if (!endpointUrl) {
  const testPort = await getFreePort(Number(process.env.CONTROL_PORT || 3005));
  serverProc = spawn(process.execPath, ['mcp/http.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONTROL_PORT: String(testPort),
      CONTROL_WORKSPACE: WORKSPACE,
      CONTROL_PERMISSIONS: JSON.stringify({
        Files: 'Allow',
        Git: 'Allow',
        Terminal: 'Allow',
        Browser: 'Blocked',
      }),
    },
    stdio: ['inherit', 'pipe', 'inherit'],
  });

  const waitForHealth = async (retries = 30) => {
    for (let i = 0; i < retries; i++) {
      try {
        const ok = await new Promise((resolve) => {
          const req = http.get(`http://127.0.0.1:${testPort}/health`, (res) => {
            resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(500, () => {
            req.destroy();
            resolve(false);
          });
        });
        if (ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`MCP test server failed to become healthy on port ${testPort}`);
  };

  await waitForHealth();
  endpointUrl = `http://127.0.0.1:${testPort}/mcp`;
}

const ENDPOINT = new URL(endpointUrl);

const results = [];
let passed = 0;
let failed = 0;

const makeClient = async () => {
  const client = new Client({ name: 'hearth-safety-test', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(ENDPOINT));
  return client;
};

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✅ PASS  ${name}`);
    results.push({ name, status: 'PASS' });
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL  ${name}`);
    console.error(`           ${err.message}`);
    results.push({ name, status: 'FAIL', error: err.message });
    failed++;
  }
};

const assert = (condition, message) => { if (!condition) throw new Error(message); };

// ── Connect ────────────────────────────────────────────────────────────────
console.log(`\nConnecting to ${ENDPOINT.href}…`);
const client = await makeClient();
console.log('Connected.\n');

// ── Section 1: Basic tools ─────────────────────────────────────────────────
console.log('═══ Section 1: Core tools ═══');

await test('workspace_info returns JSON with workspace field', async () => {
  const res = await client.callTool({ name: 'workspace_info', arguments: {} });
  assert(!res.isError, `Error: ${res.content?.[0]?.text}`);
  const info = JSON.parse(res.content[0].text);
  assert(typeof info.workspace !== 'undefined', 'workspace field missing');
});

await test('list_files in workspace root succeeds', async () => {
  const res = await client.callTool({ name: 'list_files', arguments: { path: '.' } });
  assert(!res.isError, `Error: ${res.content?.[0]?.text}`);
});

await test('read_file reads a known file (package.json)', async () => {
  const res = await client.callTool({ name: 'read_file', arguments: { path: 'package.json' } });
  assert(!res.isError, `Error: ${res.content?.[0]?.text}`);
  assert(res.content[0].text.includes('hearth-control'), 'package.json content unexpected');
});

await test('search_files finds text in workspace', async () => {
  const res = await client.callTool({ name: 'search_files', arguments: { query: 'hearth-control', path: '.' } });
  assert(!res.isError, `Error: ${res.content?.[0]?.text}`);
  assert(res.content[0].text !== 'No matches', 'Expected at least one match');
});

await test('git_status returns output or git-specific error', async () => {
  const res = await client.callTool({ name: 'git_status', arguments: {} });
  // Tool must always return a response — either success or a git/workspace error.
  // Unexpected system crashes or permission errors would not have isError set.
  if (res.isError) {
    const msg = res.content[0].text;
    // Accept only git-expected errors; reject anything that looks like a tool crash
    assert(
      msg.includes('git') || msg.includes('repository') || msg.includes('workspace') || msg.includes('No valid workspace'),
      `Unexpected error from git_status: ${msg}`
    );
  }
  // If no error, it returned status output — also valid
});

await test('git_diff returns output or git-specific error', async () => {
  const res = await client.callTool({ name: 'git_diff', arguments: { staged: false } });
  if (res.isError) {
    const msg = res.content[0].text;
    assert(
      msg.includes('git') || msg.includes('repository') || msg.includes('workspace') || msg.includes('No valid workspace'),
      `Unexpected error from git_diff: ${msg}`
    );
  }
});

// ── Section 2: Path traversal / workspace boundary ─────────────────────────
console.log('\n═══ Section 2: Path traversal must be blocked ═══');

await test('read_file ../../../etc/hosts is blocked', async () => {
  const res = await client.callTool({ name: 'read_file', arguments: { path: '../../../etc/hosts' } });
  assert(res.isError === true, 'Expected isError=true but got success');
  assert(res.content[0].text.includes('workspace') || res.content[0].text.includes('escap') || res.content[0].text.includes('outside'),
    `Unexpected error message: ${res.content[0].text}`);
});

await test('list_files ../ is blocked', async () => {
  const res = await client.callTool({ name: 'list_files', arguments: { path: '../' } });
  assert(res.isError === true, 'Expected isError=true but got success');
});

await test('write_file ../escape.txt is blocked', async () => {
  const res = await client.callTool({ name: 'write_file', arguments: { path: '../escape.txt', content: 'bad' } });
  assert(res.isError === true, 'Expected isError=true but got success');
});

// ── Section 3: write_file size limit ──────────────────────────────────────
console.log('\n═══ Section 3: write_file limits ═══');

await test('write_file with content > 10 MB is rejected', async () => {
  const bigContent = 'x'.repeat(11 * 1024 * 1024); // 11 MB
  let res;
  try {
    res = await client.callTool({ name: 'write_file', arguments: { path: 'test-size-limit.txt', content: bigContent } });
  } catch (clientErr) {
    // HTTP-level rejection (413 / connection error) also counts as correct behaviour
    assert(clientErr instanceof Error, 'Expected an Error from client');
    return; // PASS — server refused the oversized payload
  }
  assert(res.isError === true, 'Expected isError=true for oversized content');
  assert(res.content[0].text.includes('MB') || res.content[0].text.includes('large'),
    `Unexpected error message: ${res.content[0].text}`);
});

await test('write_file with reasonable content succeeds (in workspace)', async () => {
  const res = await client.callTool({ name: 'write_file', arguments: { path: 'test-safety-write.txt', content: 'safety test\n' } });
  assert(!res.isError, `Error: ${res.content?.[0]?.text}`);
  assert(res.content[0].text.includes('bytes'), `Unexpected response: ${res.content[0].text}`);
});

// ── Section 4: run_command destructive command blocking ────────────────────
console.log('\n═══ Section 4: Blocked destructive commands ═══');

await test('run_command rm -rf . is blocked (not just permission denied)', async () => {
  const res = await client.callTool({ name: 'run_command', arguments: { command: 'rm', args: ['-rf', '.'], cwd: '.' } });
  assert(res.isError === true, 'Expected isError=true but got success');
  const msg = res.content[0].text;
  assert(msg.includes('BLOCKED') || msg.includes('blocked'), `Expected BLOCKED message, got: ${msg}`);
});

await test('run_command rm -r subdir is blocked', async () => {
  const res = await client.callTool({ name: 'run_command', arguments: { command: 'rm', args: ['-r', 'outputs'], cwd: '.' } });
  assert(res.isError === true, 'Expected isError=true');
  const msg = res.content[0].text;
  assert(msg.includes('BLOCKED') || msg.includes('blocked'), `Expected BLOCKED message, got: ${msg}`);
});

await test('run_command sudo is blocked', async () => {
  const res = await client.callTool({ name: 'run_command', arguments: { command: 'sudo', args: ['ls'], cwd: '.' } });
  assert(res.isError === true, 'Expected isError=true');
  const msg = res.content[0].text;
  assert(msg.includes('BLOCKED') || msg.includes('blocked'), `Expected BLOCKED message, got: ${msg}`);
});

await test('run_command dd is blocked', async () => {
  const res = await client.callTool({ name: 'run_command', arguments: { command: 'dd', args: ['if=/dev/zero', 'of=test.img', 'bs=1', 'count=1'], cwd: '.' } });
  assert(res.isError === true, 'Expected isError=true');
  const msg = res.content[0].text;
  assert(msg.includes('BLOCKED') || msg.includes('blocked'), `Expected BLOCKED message, got: ${msg}`);
});

await test('run_command shutdown is blocked', async () => {
  const res = await client.callTool({ name: 'run_command', arguments: { command: 'shutdown', args: ['-h', 'now'], cwd: '.' } });
  assert(res.isError === true, 'Expected isError=true');
  const msg = res.content[0].text;
  assert(msg.includes('BLOCKED') || msg.includes('blocked'), `Expected BLOCKED message, got: ${msg}`);
});

await test('run_command reboot is blocked', async () => {
  const res = await client.callTool({ name: 'run_command', arguments: { command: 'reboot', args: [], cwd: '.' } });
  assert(res.isError === true, 'Expected isError=true');
  const msg = res.content[0].text;
  assert(msg.includes('BLOCKED') || msg.includes('blocked'), `Expected BLOCKED message, got: ${msg}`);
});

await test('run_command diskutil erase is blocked', async () => {
  const res = await client.callTool({ name: 'run_command', arguments: { command: 'diskutil', args: ['eraseDisk', 'JHFS+', 'test', '/dev/disk99'], cwd: '.' } });
  assert(res.isError === true, 'Expected isError=true');
  const msg = res.content[0].text;
  assert(msg.includes('BLOCKED') || msg.includes('blocked'), `Expected BLOCKED message, got: ${msg}`);
});

// ── Section 5: run_command harmless command (Terminal = Allow expected) ────
console.log('\n═══ Section 5: Harmless commands (Terminal permission) ═══');

// Note: if Terminal permission is Ask/Blocked these will fail due to permission, not block policy
// This tests that non-destructive commands pass the block policy check
await test('run_command pwd passes block policy', async () => {
  const res = await client.callTool({ name: 'run_command', arguments: { command: 'pwd', args: [], cwd: '.' } });
  // Should either succeed (if Terminal=Allow) or fail with permission error (not BLOCKED)
  if (res.isError) {
    const msg = res.content[0].text;
    assert(!msg.includes('BLOCKED') && !msg.includes('blocked'),
      `pwd should not be blocked, but got: ${msg}`);
  }
});

await test('run_command git status passes block policy', async () => {
  const res = await client.callTool({ name: 'run_command', arguments: { command: 'git', args: ['status', '--short'], cwd: '.' } });
  if (res.isError) {
    const msg = res.content[0].text;
    assert(!msg.includes('BLOCKED') && !msg.includes('blocked'),
      `git status should not be blocked, but got: ${msg}`);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────
await client.close();

if (serverProc?.pid) {
  serverProc.kill('SIGTERM');
}
try {
  fs.rmSync('test-safety-write.txt', { force: true });
} catch {}

console.log('\n══════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
console.log('══════════════════════════════════════════\n');

if (failed > 0) {
  console.log('Failed tests:');
  results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.name}: ${r.error}`));
  process.exit(1);
}

