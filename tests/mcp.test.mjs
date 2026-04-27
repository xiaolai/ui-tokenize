// MCP server end-to-end tests over stdio JSON-RPC.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const SERVER = join(PLUGIN_ROOT, 'mcp', 'server.mjs');

function setupConsumer() {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-mcp-c-'));
  writeFileSync(join(root, 'package.json'), '{"name":"mcp-test"}');
  writeFileSync(join(root, 'tokens.json'), JSON.stringify({
    color: { primary: { $value: '#2563eb', $type: 'color' } },
    space: { 4: { $value: '16px', $type: 'dimension' } },
  }));
  return root;
}

/**
 * Run the MCP server, send each line of `messages`, collect line-delimited responses,
 * resolve when `expectedCount` responses received OR timeout.
 */
async function callServer(cwd, messages, expectedCount) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('node', [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    /** @type {object[]} */
    const responses = [];
    let buf = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectP(new Error(`timeout after ${responses.length}/${expectedCount} responses; buf=${buf.slice(0, 200)}`));
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
        } catch { /* skip malformed */ }
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      if (responses.length < expectedCount) rejectP(new Error(`server exited; only got ${responses.length}/${expectedCount} responses`));
      else resolveP(responses);
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
  });
}

test('MCP: initialize returns protocol version', async () => {
  const root = setupConsumer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    ], 1);
    assert.equal(responses[0].result.protocolVersion, '2024-11-05');
    assert.equal(responses[0].result.serverInfo.name, 'ui-tokenize');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP: tools/list excludes maintainer-only tools in consumer mode', async () => {
  const root = setupConsumer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ], 2);
    const tools = responses[1].result.tools.map((t) => t.name);
    assert.ok(tools.includes('tokenize__list_tokens'));
    assert.ok(tools.includes('tokenize__find_closest'));
    assert.ok(tools.includes('tokenize__propose'));
    assert.ok(!tools.includes('tokenize__add_token'), 'add_token must not appear in consumer mode');
    assert.ok(!tools.includes('tokenize__deprecate'), 'deprecate must not appear in consumer mode');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP: tools/call list_tokens returns catalog content', async () => {
  const root = setupConsumer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__list_tokens', arguments: {} } },
    ], 2);
    const text = responses[1].result.content[0].text;
    assert.ok(text.includes('color.primary'));
    assert.ok(text.includes('space.4'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP: tools/call propose appends to tokens.proposed.json', async () => {
  const root = setupConsumer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__propose', arguments: { value: '#fb923c', intent: 'warning-bg' } } },
    ], 2);
    const text = responses[1].result.content[0].text;
    assert.ok(text.includes('__proposed.'));
    const proposalsPath = join(root, 'tokens.proposed.json');
    assert.ok(existsSync(proposalsPath), 'tokens.proposed.json should be created');
    const proposals = JSON.parse(readFileSync(proposalsPath, 'utf8'));
    assert.equal(proposals.proposals.length, 1);
    assert.equal(proposals.proposals[0].value, '#fb923c');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP: tools/call propose with missing args returns isError', async () => {
  const root = setupConsumer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__propose', arguments: {} } },
    ], 2);
    assert.ok(responses[1].result.isError, 'should set isError on validation failure');
    assert.ok(responses[1].result.content[0].text.includes('required'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP: unknown method returns JSON-RPC error', async () => {
  const root = setupConsumer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'nonexistent/method' },
    ], 2);
    assert.ok(responses[1].error);
    assert.equal(responses[1].error.code, -32601);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP: unknown tool returns JSON-RPC error (not isError)', async () => {
  const root = setupConsumer();
  try {
    const responses = await callServer(root, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tokenize__nonexistent', arguments: {} } },
    ], 2);
    assert.ok(responses[1].error, 'unknown tool is a protocol error, not a tool-error');
    assert.equal(responses[1].error.code, -32602);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
