// Maintainer-mode validation tests via the MCP server in maintainer mode.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const SERVER = join(PLUGIN_ROOT, 'mcp', 'server.mjs');

function setupMaintainer() {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-mnt-'));
  writeFileSync(join(root, 'package.json'), '{"name":"mnt-test"}');
  writeFileSync(join(root, 'tokens.json'), JSON.stringify({
    color: {
      primary: { $value: '#2563eb', $type: 'color' },
      group: {
        nested: { $value: '#ff0000', $type: 'color' },
      },
    },
  }, null, 2));
  mkdirSync(join(root, '.tokenize'), { recursive: true });
  writeFileSync(join(root, '.tokenize', 'config.json'), JSON.stringify({ mode: 'maintainer' }));
  return root;
}

async function callServer(cwd, messages, expectedCount) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('node', [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = [];
    let buf = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectP(new Error(`timeout after ${responses.length}/${expectedCount}`));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line));
          if (responses.length >= expectedCount) {
            clearTimeout(timer);
            child.kill('SIGTERM');
            resolveP(responses);
          }
        } catch { /* skip */ }
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      if (responses.length < expectedCount) rejectP(new Error('server exited early'));
      else resolveP(responses);
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
}

test('maintainer: tools/list exposes add_token and deprecate', async () => {
  const root = setupMaintainer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ], 2);
    const tools = responses[1].result.tools.map((t) => t.name);
    assert.ok(tools.includes('tokenize__add_token'));
    assert.ok(tools.includes('tokenize__deprecate'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintainer: add_token rejects invalid name', async () => {
  const root = setupMaintainer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__add_token', arguments: { name: 'BadName', value: '#000', type: 'color' } } },
    ], 2);
    assert.ok(responses[1].result.isError);
    assert.ok(responses[1].result.content[0].text.includes('convention'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintainer: add_token rejects malformed value for color type', async () => {
  const root = setupMaintainer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__add_token', arguments: { name: 'color.bad', value: 'not-a-color', type: 'color' } } },
    ], 2);
    assert.ok(responses[1].result.isError);
    assert.ok(responses[1].result.content[0].text.includes('not a valid color'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintainer: add_token rejects intermediate-token-collision', async () => {
  const root = setupMaintainer();
  try {
    // color.primary is a token; trying to add color.primary.dark would go under it.
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__add_token', arguments: { name: 'color.primary.dark', value: '#000', type: 'color' } } },
    ], 2);
    assert.ok(responses[1].result.isError);
    assert.ok(responses[1].result.content[0].text.includes('intermediate'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintainer: add_token rejects group-name collision', async () => {
  const root = setupMaintainer();
  try {
    // color.group is a group node (has children but no $value).
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__add_token', arguments: { name: 'color.group', value: '#000', type: 'color' } } },
    ], 2);
    assert.ok(responses[1].result.isError);
    assert.ok(responses[1].result.content[0].text.includes('group'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintainer: add_token writes atomically and updates tokens.json', async () => {
  const root = setupMaintainer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__add_token', arguments: { name: 'color.success', value: '#10b981', type: 'color', description: 'success state' } } },
    ], 2);
    assert.ok(!responses[1].result.isError, `should succeed, got: ${JSON.stringify(responses[1])}`);
    const doc = JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8'));
    assert.equal(doc.color.success.$value, '#10b981');
    assert.equal(doc.color.success.$type, 'color');
    assert.equal(doc.color.success.$description, 'success state');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintainer: deprecate rejects non-existent token', async () => {
  const root = setupMaintainer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__deprecate', arguments: { name: 'color.does-not-exist', reason: 'unused' } } },
    ], 2);
    assert.ok(responses[1].result.isError);
    assert.ok(responses[1].result.content[0].text.includes('not found'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintainer: deprecate rejects when target is a group', async () => {
  const root = setupMaintainer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__deprecate', arguments: { name: 'color.group', reason: 'reorg' } } },
    ], 2);
    assert.ok(responses[1].result.isError);
    assert.ok(responses[1].result.content[0].text.includes('group'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintainer: deprecate marks $deprecated and writes atomically', async () => {
  const root = setupMaintainer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__deprecate', arguments: { name: 'color.primary', reason: 'replaced by color.brand' } } },
    ], 2);
    assert.ok(!responses[1].result.isError, `should succeed: ${JSON.stringify(responses[1])}`);
    const doc = JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8'));
    assert.equal(doc.color.primary.$deprecated, true);
    assert.ok(doc.color.primary.$description.includes('DEPRECATED'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumer mode: add_token / deprecate are listed but reject at call-time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-cons-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    writeFileSync(join(root, 'tokens.json'), JSON.stringify({ color: { x: { $value: '#000', $type: 'color' } } }));
    // No config.json → defaults to consumer mode.
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tokenize__add_token', arguments: { name: 'color.y', value: '#fff', type: 'color' } } },
    ], 3);
    const tools = responses[1].result.tools.map((t) => t.name);
    // Always-listed regardless of mode (so mode flips work without restart) —
    // but the call still rejects in consumer mode.
    assert.ok(tools.includes('tokenize__add_token'));
    assert.ok(tools.includes('tokenize__deprecate'));
    assert.ok(responses[2].result.isError);
    assert.ok(responses[2].result.content[0].text.includes('maintainer mode'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
