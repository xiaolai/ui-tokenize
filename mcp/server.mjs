#!/usr/bin/env node
// Minimal MCP stdio server exposing tokenize__* tools.
// JSON-RPC 2.0 over stdin/stdout, line-delimited (one JSON message per line).
// Implements the subset of MCP spec needed for: initialize, tools/list, tools/call.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { discoverCatalog, readCatalog, writeCatalog } from '../lib/catalog.mjs';
import { suggest } from '../lib/suggester.mjs';
import { parseColor } from '../lib/color.mjs';
import { parseDimension } from '../lib/dimension.mjs';
import { findRepoRoot, findTokenRoot } from '../lib/paths.mjs';
import { readConfig } from '../lib/config.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const NAME_RE = /^[a-z][a-z0-9.-]*$/;

const cwd = process.cwd();
const root = findTokenRoot(cwd) || findRepoRoot(cwd) || cwd;

const TOOLS = [
  {
    name: 'tokenize__list_tokens',
    description: 'List the live design-token catalog. Optional `category` filter (color | dimension | radius | shadow | duration | other).',
    inputSchema: {
      type: 'object',
      properties: { category: { type: 'string' } },
    },
  },
  {
    name: 'tokenize__find_closest',
    description: 'Find the nearest token in the catalog for a given literal value (color or dimension). Returns up to 3 ranked candidates with confidence.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The literal value, e.g. "#2563eb" or "16px"' },
        type:  { type: 'string', enum: ['color', 'dimension'], description: 'Token category' },
      },
      required: ['value', 'type'],
    },
  },
  {
    name: 'tokenize__propose',
    description: 'Propose a new token when no existing token matches. Appends to tokens.proposed.json (queued for human review) and returns a temporary __proposed.* name you can use immediately. Always available regardless of mode.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The value to tokenize, e.g. "#fb923c"' },
        intent: { type: 'string', description: 'Short purpose / use case, e.g. "warning-banner-bg"' },
      },
      required: ['value', 'intent'],
    },
  },
  {
    name: 'tokenize__add_token',
    description: 'MAINTAINER MODE ONLY. Add a real token to tokens.json with strict DTCG + naming + collision validation. Use only when the project is in maintainer mode and the token has been agreed.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Dot-path token name, e.g. "color.text.danger". Lowercase, alphanumeric, hyphen and dot only.' },
        value: { type: 'string' },
        type: { type: 'string', enum: ['color', 'dimension', 'radius', 'shadow', 'duration', 'other'] },
        description: { type: 'string' },
      },
      required: ['name', 'value', 'type'],
    },
  },
  {
    name: 'tokenize__deprecate',
    description: 'MAINTAINER MODE ONLY. Mark a token as deprecated. Future suggestions will exclude it. Optional replacement is recorded for migration tooling.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        reason: { type: 'string' },
        replacement: { type: 'string' },
      },
      required: ['name', 'reason'],
    },
  },
];

const handlers = {
  'initialize':       handleInitialize,
  'tools/list':       handleToolsList,
  'tools/call':       handleToolsCall,
  'notifications/initialized': () => null,
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  Promise.resolve(dispatch(req)).then((result) => {
    if (result === null) return;        // notification
    if (req.id === undefined) return;
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch((err) => {
    process.stdout.write(JSON.stringify(errorResponse(req?.id, -32000, err.message)) + '\n');
  });
});

async function dispatch(req) {
  const handler = handlers[req.method];
  if (!handler) return errorResponse(req.id, -32601, `Method not found: ${req.method}`);
  try {
    return handler(req);
  } catch (err) {
    return errorResponse(req.id, -32603, `Internal error: ${err.message}`);
  }
}

function handleInitialize(req) {
  return {
    jsonrpc: '2.0',
    id: req.id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'ui-tokenize', version: '0.1.0' },
    },
  };
}

function handleToolsList(req) {
  const config = readConfig(root);
  const tools = TOOLS.filter((t) => {
    if (t.name === 'tokenize__add_token' || t.name === 'tokenize__deprecate') {
      return config.mode === 'maintainer';
    }
    return true;
  });
  return { jsonrpc: '2.0', id: req.id, result: { tools } };
}

function handleToolsCall(req) {
  const { name, arguments: args = {} } = req.params || {};
  /** @type {(args: object) => object} */
  let impl;
  switch (name) {
    case 'tokenize__list_tokens':   impl = listTokens; break;
    case 'tokenize__find_closest':  impl = findClosest; break;
    case 'tokenize__propose':       impl = proposeToken; break;
    case 'tokenize__add_token':     impl = addToken; break;
    case 'tokenize__deprecate':     impl = deprecateToken; break;
    default:                        return errorResponse(req.id, -32602, `Unknown tool: ${name}`);
  }
  // Tool execution failures are returned as CallToolResult with isError: true so the
  // model can read the error text and self-correct (per MCP spec). JSON-RPC errors are
  // reserved for protocol-level failures (unknown method, malformed request).
  try {
    const content = impl(args);
    return { jsonrpc: '2.0', id: req.id, result: { content: [content] } };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: req.id,
      result: {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      },
    };
  }
}

// --------------------------------------------------------------------------------
// Tool implementations
// --------------------------------------------------------------------------------

function listTokens({ category }) {
  const cat = readCatalog(root);
  if (!cat) return textContent('No catalog yet. Run /tokenize:init or invoke at SessionStart to build one.');
  const items = Object.values(cat.tokens)
    .filter((t) => t.tier !== 'primitive' && !t.deprecated)
    .filter((t) => !category || t.type === category)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (items.length === 0) return textContent(`No tokens for category=${category ?? 'all'}.`);
  const text = items.map((t) => `${t.name} = ${t.value}${t.description ? ` — ${t.description}` : ''}`).join('\n');
  return textContent(text);
}

function findClosest({ value, type }) {
  const cat = readCatalog(root);
  if (!cat) return textContent('No catalog yet.');
  const violation = { literal: String(value), type, surface: 'css', line: 0, column: 0 };
  const result = suggest(violation, cat);
  if (!result.primary) return textContent(`No catalog match for ${value}. Consider tokenize__propose.`);
  const lines = [`primary: ${result.primary.tokenName} = ${result.primary.tokenValue} (confidence ${(result.primary.confidence * 100).toFixed(0)}%)`];
  for (const a of result.alternates) {
    lines.push(`alt: ${a.tokenName} = ${a.tokenValue} (confidence ${(a.confidence * 100).toFixed(0)}%)`);
  }
  return textContent(lines.join('\n'));
}

function proposeToken({ value, intent }) {
  if (!value || !intent) throw new Error('value and intent are required');
  const proposalsPath = join(root, 'tokens.proposed.json');
  const existing = existsSync(proposalsPath)
    ? safeReadJson(proposalsPath, { proposals: [] })
    : { proposals: [] };
  const tempName = `__proposed.${camelize(intent)}`;
  const id = `prop_${new Date().toISOString().slice(0, 10)}_${String(existing.proposals.length + 1).padStart(3, '0')}`;
  existing.proposals.push({
    id,
    value: String(value),
    intent: String(intent),
    proposedTokenName: nameFromIntent(intent, value),
    callerFile: process.env.CLAUDE_TOOL_CALLER_FILE || null,
    timestamp: new Date().toISOString(),
    status: 'pending',
    tempName,
  });
  writeFileSync(proposalsPath, JSON.stringify(existing, null, 2));
  return textContent(`Proposed. Use ${tempName} immediately; the real name will be assigned on human review.\n\nFile: ${proposalsPath}\nId: ${id}`);
}

function addToken({ name, value, type, description }) {
  const config = readConfig(root);
  if (config.mode !== 'maintainer') throw new Error('add_token requires maintainer mode (set "mode": "maintainer" in .tokenize/config.json)');
  if (!NAME_RE.test(String(name))) throw new Error(`name "${name}" violates convention ^[a-z][a-z0-9.-]*$`);
  if (!validateValue(type, value)) throw new Error(`value "${value}" is not a valid ${type}`);

  const tokensPath = join(root, 'tokens.json');
  const doc = existsSync(tokensPath) ? safeReadJson(tokensPath, {}) : {};
  if (lookupName(doc, name)) throw new Error(`token "${name}" already exists`);
  setName(doc, name, { $value: value, $type: type, ...(description ? { $description: description } : {}) });
  mkdirSync(dirname(tokensPath), { recursive: true });
  writeFileSync(tokensPath, JSON.stringify(doc, null, 2));
  // Re-discover so subsequent tool calls see the new token.
  try { writeCatalog(discoverCatalog(root)); } catch { /* non-fatal */ }
  return textContent(`Added ${name} = ${value} (${type}).`);
}

function deprecateToken({ name, reason, replacement }) {
  const config = readConfig(root);
  if (config.mode !== 'maintainer') throw new Error('deprecate requires maintainer mode');
  const tokensPath = join(root, 'tokens.json');
  if (!existsSync(tokensPath)) throw new Error(`tokens.json not found at ${tokensPath}`);
  const doc = safeReadJson(tokensPath, {});
  const node = lookupName(doc, name);
  if (!node) throw new Error(`token "${name}" not found`);
  node.$deprecated = true;
  node.$description = `${node.$description ?? ''}\nDEPRECATED: ${reason}${replacement ? ` (use ${replacement})` : ''}`.trim();
  writeFileSync(tokensPath, JSON.stringify(doc, null, 2));
  try { writeCatalog(discoverCatalog(root)); } catch { /* non-fatal */ }
  return textContent(`Deprecated ${name}: ${reason}${replacement ? ` (replacement: ${replacement})` : ''}.`);
}

// --------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------

function textContent(text) {
  return { type: 'text', text };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function safeReadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function camelize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[^a-z]/, '');
}

function nameFromIntent(intent, value) {
  const cat = parseColor(value) ? 'color' : parseDimension(value) ? 'space' : 'token';
  return `${cat}.${kebab(intent)}`;
}

function kebab(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function lookupName(doc, dotName) {
  const parts = String(dotName).split('.');
  let node = doc;
  for (const p of parts) {
    if (!node || typeof node !== 'object' || !(p in node)) return null;
    node = node[p];
  }
  return node;
}

function setName(doc, dotName, payload) {
  const parts = String(dotName).split('.');
  let node = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = payload;
}

function validateValue(type, value) {
  const v = String(value);
  if (type === 'color') return parseColor(v) !== null || /^[a-z][a-z0-9-]*$/.test(v);
  if (type === 'dimension' || type === 'radius') return parseDimension(v) !== null;
  if (type === 'duration') return /^\d+(\.\d+)?\s*(ms|s)$/i.test(v);
  return v.length > 0;
}
