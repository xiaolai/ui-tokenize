#!/usr/bin/env node
// Minimal MCP stdio server exposing tokenize__* tools.
// JSON-RPC 2.0 over stdin/stdout, line-delimited (one JSON message per line).
// Implements the subset of MCP spec needed for: initialize, tools/list, tools/call.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { discoverCatalog, readCatalog, writeCatalog } from '../lib/catalog.mjs';
import { suggest } from '../lib/suggester.mjs';
import { parseColor } from '../lib/color.mjs';
import { parseDimension } from '../lib/dimension.mjs';
import { findRepoRoot, findTokenRoot, tokenizeDir } from '../lib/paths.mjs';
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
  const cat = ensureCatalog();
  if (!cat) return textContent('No tokens discovered. Run /tokenize:init to scaffold or define tokens first.');
  const items = Object.values(cat.tokens)
    .filter((t) => t.tier !== 'primitive' && !t.deprecated)
    .filter((t) => !category || t.type === category)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (items.length === 0) return textContent(`No tokens for category=${category ?? 'all'}.`);
  const text = items.map((t) => `${t.name} = ${t.value}${t.description ? ` — ${t.description}` : ''}`).join('\n');
  return textContent(text);
}

function findClosest({ value, type }) {
  const cat = ensureCatalog();
  if (!cat) return textContent('No tokens discovered.');
  const violation = { literal: String(value), type, surface: 'css', line: 0, column: 0 };
  const result = suggest(violation, cat);
  if (!result.primary) return textContent(`No catalog match for ${value}. Consider tokenize__propose.`);
  const lines = [`primary: ${result.primary.tokenName} = ${result.primary.tokenValue} (confidence ${(result.primary.confidence * 100).toFixed(0)}%)`];
  for (const a of result.alternates) {
    lines.push(`alt: ${a.tokenName} = ${a.tokenValue} (confidence ${(a.confidence * 100).toFixed(0)}%)`);
  }
  return textContent(lines.join('\n'));
}

/**
 * Read cached catalog; fall back to live discovery when SessionStart hasn't run.
 * Also caches the result on first miss so subsequent tool calls in the same MCP
 * session don't repeatedly walk the tree.
 */
function ensureCatalog() {
  const cached = readCatalog(root);
  if (cached) return cached;
  try {
    const fresh = discoverCatalog(root);
    if (Object.keys(fresh.tokens).length > 0) {
      writeCatalog(fresh);
      return fresh;
    }
  } catch { /* ignore */ }
  return null;
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
  if (config.mode !== 'maintainer') {
    throw new Error('add_token requires maintainer mode (set "mode": "maintainer" in .tokenize/config.json)');
  }
  validateName(name);
  validateType(type);
  validateValueStrict(type, value);

  const tokensPath = join(root, 'tokens.json');
  const doc = existsSync(tokensPath) ? safeReadJson(tokensPath, {}) : {};
  // 1. Reject if exact token already exists.
  const existing = lookupTokenNode(doc, name);
  if (existing) throw new Error(`token "${name}" already exists with $value=${JSON.stringify(existing.$value)}`);
  // 2. Reject if any intermediate path segment is itself a token node — would corrupt structure.
  const intermediate = findIntermediateToken(doc, name);
  if (intermediate) {
    throw new Error(`cannot add "${name}": intermediate path "${intermediate}" is itself a token (has $value); choose a different namespace`);
  }
  // 3. Reject if the target path resolves to a group (object with non-token children).
  if (lookupGroupNode(doc, name)) {
    throw new Error(`"${name}" already names a token group; use a leaf path instead`);
  }
  setLeaf(doc, name, { $value: value, $type: type, ...(description ? { $description: description } : {}) });
  // 4. Detect same-value collision (warning only, logged to conflicts).
  const collision = findValueCollision(doc, name, value);
  if (collision) {
    logConflict({
      tokenName: name,
      definitions: [
        { source: `tokens.json:new`, value },
        { source: `tokens.json:${collision}`, value },
      ],
      resolution: 'both-kept',
      detectedAt: new Date().toISOString(),
    });
  }
  // 5. Atomic write + cache refresh.
  atomicWriteJson(tokensPath, doc);
  try { writeCatalog(discoverCatalog(root)); } catch { /* non-fatal */ }
  const note = collision ? ` (NOTE: same value as "${collision}" — logged to .tokenize/conflicts.json)` : '';
  return textContent(`Added ${name} = ${value} (${type}).${note}`);
}

function deprecateToken({ name, reason, replacement }) {
  const config = readConfig(root);
  if (config.mode !== 'maintainer') throw new Error('deprecate requires maintainer mode');
  const tokensPath = join(root, 'tokens.json');
  if (!existsSync(tokensPath)) throw new Error(`tokens.json not found at ${tokensPath}`);
  const doc = safeReadJson(tokensPath, {});
  const node = lookupTokenNode(doc, name);
  if (!node) {
    if (lookupGroupNode(doc, name)) {
      throw new Error(`"${name}" is a token group, not a token; deprecate individual children instead`);
    }
    throw new Error(`token "${name}" not found`);
  }
  if (replacement && !lookupTokenNode(doc, replacement)) {
    throw new Error(`replacement token "${replacement}" does not exist`);
  }
  node.$deprecated = true;
  node.$description = `${node.$description ?? ''}\nDEPRECATED: ${reason}${replacement ? ` (use ${replacement})` : ''}`.trim();
  atomicWriteJson(tokensPath, doc);
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

/**
 * Walk the dotted name and return the node only if it's a valid DTCG token node
 * (object with `$value`). Returns null for groups, missing paths, or aliases that
 * weren't resolved to a token.
 */
function lookupTokenNode(doc, dotName) {
  const node = walkPath(doc, dotName);
  return isTokenNode(node) ? node : null;
}

/**
 * Walk the dotted name and return the node only if it's a *group* (object without
 * `$value`). Used to reject mutations that would clobber a group.
 */
function lookupGroupNode(doc, dotName) {
  const node = walkPath(doc, dotName);
  if (!node || typeof node !== 'object') return null;
  return !isTokenNode(node) ? node : null;
}

/**
 * Find an intermediate path segment that is a token node (would prevent extending
 * the path). Returns the dotted path of that intermediate, or null.
 */
function findIntermediateToken(doc, dotName) {
  const parts = String(dotName).split('.');
  let node = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node || typeof node !== 'object' || !(parts[i] in node)) return null;
    node = node[parts[i]];
    if (isTokenNode(node)) return parts.slice(0, i + 1).join('.');
  }
  return null;
}

/**
 * Walk the dotted path; return whatever's there or null.
 */
function walkPath(doc, dotName) {
  const parts = String(dotName).split('.');
  let node = doc;
  for (const p of parts) {
    if (!node || typeof node !== 'object' || !(p in node)) return null;
    node = node[p];
  }
  return node;
}

function isTokenNode(node) {
  return !!(node && typeof node === 'object' && '$value' in node);
}

function setLeaf(doc, dotName, payload) {
  const parts = String(dotName).split('.');
  let node = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = payload;
}

function findValueCollision(doc, newName, newValue) {
  const collisions = [];
  walkTokens(doc, [], (path, tokenNode) => {
    const name = path.join('.');
    if (name === newName) return;
    if (String(tokenNode.$value) === String(newValue)) collisions.push(name);
  });
  return collisions[0] || null;
}

function walkTokens(node, path, fn) {
  if (!node || typeof node !== 'object') return;
  if (isTokenNode(node)) { fn(path, node); return; }
  for (const k of Object.keys(node)) {
    if (k.startsWith('$')) continue;
    walkTokens(node[k], [...path, k], fn);
  }
}

function validateName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`name "${name}" violates convention ^[a-z][a-z0-9.-]*$`);
  }
  if (name.endsWith('.') || name.startsWith('.') || name.includes('..')) {
    throw new Error(`name "${name}" has malformed dot-segments`);
  }
}

function validateType(type) {
  const allowed = ['color', 'dimension', 'radius', 'shadow', 'duration', 'other', 'fontFamily', 'fontWeight', 'number'];
  if (!allowed.includes(String(type))) {
    throw new Error(`type "${type}" is not allowed; use one of: ${allowed.join(', ')}`);
  }
}

function validateValueStrict(type, value) {
  const v = String(value);
  if (v.length === 0) throw new Error('value cannot be empty');
  // Allow DTCG alias references at any type.
  if (/^\{[^{}]+\}$/.test(v)) return;
  if (type === 'color') {
    if (parseColor(v) === null) {
      throw new Error(`value "${v}" is not a valid color (expected hex, rgb(), rgba(), hsl(), hsla(), or DTCG alias {…})`);
    }
    return;
  }
  if (type === 'dimension' || type === 'radius') {
    if (parseDimension(v) === null) {
      throw new Error(`value "${v}" is not a valid dimension (expected NUMBER+UNIT like "16px" or DTCG alias)`);
    }
    return;
  }
  if (type === 'duration') {
    if (!/^\d+(\.\d+)?\s*(ms|s)$/i.test(v)) {
      throw new Error(`value "${v}" is not a valid duration (expected "200ms" or "0.2s")`);
    }
    return;
  }
  // Other types: accept any non-empty string for v0.1 (richer schema in v0.2).
}

/**
 * Atomic write: write to <path>.tmp.<pid>, then rename over the destination.
 * Avoids torn writes from crashes mid-write and reduces lost-update windows.
 */
function atomicWriteJson(path, doc) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(tmp, path);
}

function logConflict(entry) {
  const dir = tokenizeDir(root);
  const path = join(dir, 'conflicts.json');
  const existing = existsSync(path) ? safeReadJson(path, { conflicts: [] }) : { conflicts: [] };
  existing.conflicts.push(entry);
  atomicWriteJson(path, existing);
}
