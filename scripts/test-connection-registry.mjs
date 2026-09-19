import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionRegistry } from '../mcp/connections/registry.mjs';
import { builtinConnectionDefinitions } from '../mcp/connections/model.mjs';

const tempFile = (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-p3-registry-'));
  return path.join(dir, name);
};

test('seeds the five canonical aliases and persists them', () => {
  const storagePath = tempFile('connections.json');
  const registry = new ConnectionRegistry({
    storagePath,
    now: () => '2026-09-19T00:00:00.000Z',
  });
  assert.deepEqual(registry.load(), []);

  registry.ensure(builtinConnectionDefinitions({
    supabaseUrl: 'https://hearth.test',
    publicTasksSupabaseUrl: 'https://xgen.test',
  }));

  const aliases = registry.list().map((item) => item.alias).sort();
  assert.deepEqual(aliases, [
    'github:personal',
    'github:work',
    'supabase:hearth',
    'supabase:xgen',
    'vercel:main',
  ]);

  const reloaded = new ConnectionRegistry({ storagePath });
  reloaded.load();
  assert.equal(reloaded.get('supabase:hearth').target.url, 'https://hearth.test');
  assert.equal(reloaded.get('supabase:xgen').target.url, 'https://xgen.test');
});

test('registry contains metadata only and never secret payloads', () => {
  const storagePath = tempFile('connections.json');
  const registry = new ConnectionRegistry({ storagePath });
  registry.load();
  registry.ensure(builtinConnectionDefinitions({ supabaseUrl: 'https://hearth.test' }));

  const raw = fs.readFileSync(storagePath, 'utf8');
  assert.ok(raw.includes('credential:supabase:hearth'));
  assert.ok(!raw.includes('ACCESS_SECRET_VALUE'));
  assert.ok(!raw.includes('REFRESH_SECRET_VALUE'));
});

test('duplicate aliases fail closed on load', () => {
  const storagePath = tempFile('connections.json');
  fs.writeFileSync(storagePath, JSON.stringify({
    version: 1,
    connections: [
      { id: 'a', alias: 'github:personal', provider: 'github', label: 'A', target: {}, auth: {}, capabilities: [], status: 'UNKNOWN' },
      { id: 'b', alias: 'github:personal', provider: 'github', label: 'B', target: {}, auth: {}, capabilities: [], status: 'UNKNOWN' },
    ],
  }));

  const registry = new ConnectionRegistry({ storagePath });
  assert.throws(() => registry.load(), /connection_alias_duplicate/);
});


test('re-seeding built-in aliases preserves future provider metadata while merging canonical fields', () => {
  const storagePath = tempFile('connections.json');
  const registry = new ConnectionRegistry({
    storagePath,
    now: () => '2026-09-19T00:00:00.000Z',
  });
  registry.load();
  registry.ensure(builtinConnectionDefinitions());

  registry.upsert({
    ...registry.get('github:personal'),
    target: { account: 'future-account' },
    capabilities: ['repo.read'],
    status: 'CONNECTED',
  });

  registry.ensure(builtinConnectionDefinitions());
  const github = registry.get('github:personal');
  assert.equal(github.target.account, 'future-account');
  assert.deepEqual(github.capabilities, ['repo.read']);
  assert.equal(github.status, 'CONNECTED');
});

test('status updates persist without changing alias identity', () => {
  const storagePath = tempFile('connections.json');
  const registry = new ConnectionRegistry({
    storagePath,
    now: () => '2026-09-19T00:00:00.000Z',
  });
  registry.load();
  registry.ensure(builtinConnectionDefinitions());
  const before = registry.get('supabase:hearth');

  registry.updateStatus('supabase:hearth', 'CONNECTED', {
    checkedAt: '2026-09-19T00:01:00.000Z',
  });

  const after = registry.get('supabase:hearth');
  assert.equal(after.id, before.id);
  assert.equal(after.alias, before.alias);
  assert.equal(after.status, 'CONNECTED');
  assert.equal(after.lastCheckedAt, '2026-09-19T00:01:00.000Z');
});
