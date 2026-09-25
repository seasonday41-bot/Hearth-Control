import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { layaStatus, layaConsult, layaReview } from '../mcp/laya.mjs';

test('optional LAYA reports unavailable and advisory calls fail closed', async () => {
  const previous = process.env.HEARTH_LAYA_ENDPOINT;
  delete process.env.HEARTH_LAYA_ENDPOINT;
  try {
    assert.equal((await layaStatus()).available, false);
    await assert.rejects(layaConsult('suggest approach'), /not configured/);
  } finally { if (previous !== undefined) process.env.HEARTH_LAYA_ENDPOINT = previous; }
});

test('loopback LAYA handles status, consult and review without file access', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: Buffer.concat(chunks).toString() });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/status' ? { connected: true, provider: 'test', model: 'mock', token: 'secret' } : { advice: 'review manually' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.HEARTH_LAYA_ENDPOINT;
  process.env.HEARTH_LAYA_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await layaStatus(), { available: true, connected: true, provider: 'test', model: 'mock', mode: 'consult+review', last_error: null });
    assert.deepEqual(await layaConsult('help'), { advice: 'review manually' });
    assert.deepEqual(await layaReview({ objective: 'test' }), { advice: 'review manually' });
    assert.equal(requests.length, 3);
    assert.match(requests[1].body, /advice_only/);
    assert.match(requests[2].body, /advice_only/);
  } finally {
    if (previous === undefined) delete process.env.HEARTH_LAYA_ENDPOINT;
    else process.env.HEARTH_LAYA_ENDPOINT = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('LAYA rejects non-loopback endpoints and redirects', async () => {
  const previous = process.env.HEARTH_LAYA_ENDPOINT;
  try {
    process.env.HEARTH_LAYA_ENDPOINT = 'https://example.com/';
    await assert.rejects(layaConsult('private text'), /loopback/);
    const server = http.createServer((_req, res) => { res.writeHead(302, { location: 'https://example.com/' }); res.end(); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      process.env.HEARTH_LAYA_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
      await assert.rejects(layaConsult('private text'));
    } finally { await new Promise((resolve) => server.close(resolve)); }
  } finally {
    if (previous === undefined) delete process.env.HEARTH_LAYA_ENDPOINT;
    else process.env.HEARTH_LAYA_ENDPOINT = previous;
  }
});
