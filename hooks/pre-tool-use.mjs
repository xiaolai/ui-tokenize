#!/usr/bin/env node
// PreToolUse hook: rewrite-first on confidence-1.0 (D-018);
// deny with structured suggestions otherwise; hard-stop after 2 unresolved blocks per file (D-019).

import { readSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCatalog } from '../lib/catalog.mjs';
import { isExemptFile, scan } from '../lib/scanner.mjs';
import { suggest } from '../lib/suggester.mjs';
import { renderToken, replaceAt } from '../lib/render.mjs';
import { allowRewrite, denyWithSuggestions, hardStop } from '../lib/format.mjs';
import { appendEvent, unresolvedBlocksFor } from '../lib/ledger.mjs';
import { readConfig } from '../lib/config.mjs';
import { findRepoRoot, findTokenRoot, tokenizeDir } from '../lib/paths.mjs';

const HARD_STOP_THRESHOLD = 2;

const stdinBuf = readAllStdin();
let event;
try { event = JSON.parse(stdinBuf); } catch { passthrough('malformed event'); }

const sessionId = event.session_id || 'unknown';
const toolName = event.tool_name;
const toolInput = event.tool_input || {};

if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) passthrough('unmatched tool');

const targetFile = resolveTargetFile(toolInput);
if (!targetFile) passthrough('no resolvable file path');

const root = findTokenRoot(targetFile) || findRepoRoot(targetFile) || process.cwd();
const config = readConfig(targetFile);
if (config.disabled) passthrough('plugin disabled in config');

// Block direct edits to tokens.json from the agent BEFORE the exempt-file check
// (which would otherwise pass-through tokens.json as a "non-violation surface").
if (isTokenSourceFile(targetFile, root)) {
  if (config.mode !== 'maintainer') {
    emit(denyTokenSourceEdit(targetFile));
  } else {
    emit(denyMaintainerDirectEdit(targetFile));
  }
}

if (isExemptFile(targetFile)) passthrough('exempt file');

const catalog = readCatalog(root);
if (!catalog || Object.keys(catalog.tokens).length === 0) {
  emit(denyNoCatalog());
}

const profile = readConsumerProfile(root);
const tailwindDetected = catalog?.sources?.some((s) => s.type === 'tailwind') || false;

const candidateContents = collectEditedContents(toolInput, toolName, targetFile);
/** @type {Array<import('../lib/format.mjs').ViolationReport>} */
const allReports = [];
for (const c of candidateContents) {
  const violations = scan(c.content, targetFile, { tailwindDetected });
  for (const v of violations) {
    const result = suggest(v, catalog);
    const replacement = result.primary
      ? renderToken(result.primary.tokenName, v.surface, profile)
      : null;
    allReports.push({
      violation: v,
      primary: result.primary,
      alternates: result.alternates,
      renderedReplacement: replacement,
    });
  }
}

if (allReports.length === 0) passthrough('no violations');

// Partition into rewrites (confidence 1.0) and denies.
const rewrites = allReports.filter((r) => r.primary && r.primary.confidence === 1.0 && r.renderedReplacement);
const denies = allReports.filter((r) => !rewrites.includes(r));

if (rewrites.length > 0 && denies.length === 0) {
  // All exact matches: rewrite and allow.
  const updatedInput = applyRewrites(toolInput, toolName, candidateContents, rewrites);
  for (const r of rewrites) {
    appendEvent(targetFile, { kind: 'rewrite', sessionId, file: targetFile, line: r.violation.line, literal: r.violation.literal, token: r.primary.tokenName });
  }
  emit(allowRewrite(updatedInput, rewrites));
}

// Mixed or all-denies: surface the deny.
const unresolved = unresolvedBlocksFor(targetFile, targetFile);
if (unresolved >= HARD_STOP_THRESHOLD) {
  emit(hardStop(`Two unresolved violations already exist for ${targetFile}; further edits to this file are blocked until they are addressed via tokenize__propose or manual fix.`));
}

for (const r of denies) {
  appendEvent(targetFile, {
    kind: 'block',
    sessionId,
    file: targetFile,
    line: r.violation.line,
    literal: r.violation.literal,
    reason: r.primary ? `low-confidence-${r.primary.tokenName}` : 'no-match',
  });
}

emit(denyWithSuggestions(denies, { retryAttempt: unresolved, mode: config.mode }));

// --------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------

function readAllStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let n;
    try { n = readSync(0, buf, 0, buf.length); }
    catch (err) { if (err.code === 'EAGAIN') continue; break; }
    if (!n) break;
    chunks.push(buf.subarray(0, n).toString('utf8'));
  }
  return chunks.join('');
}

function passthrough(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `[ui-tokenize] ${reason}` },
  }));
  process.exit(0);
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

function resolveTargetFile(input) {
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  return null;
}

/**
 * Collect the new content per logical region for scanning.
 * For Write: full content. For Edit: the new_string (with surrounding context if available).
 * For MultiEdit: each edit's new_string.
 *
 * @returns {Array<{content: string, replaceFn: (newContent: string) => any}>}
 */
function collectEditedContents(input, tool, _file) {
  if (tool === 'Write') {
    return [{ content: String(input.content ?? ''), replaceFn: (c) => ({ ...input, content: c }) }];
  }
  if (tool === 'Edit') {
    const newStr = String(input.new_string ?? '');
    return [{ content: newStr, replaceFn: (c) => ({ ...input, new_string: c }) }];
  }
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.map((e, i) => ({
      content: String(e.new_string ?? ''),
      replaceFn: (c) => {
        const next = edits.map((x, j) => (j === i ? { ...x, new_string: c } : x));
        return { ...input, edits: next };
      },
    }));
  }
  return [];
}

function applyRewrites(input, _tool, candidates, reports) {
  // Group reports by candidate index (we know each violation came from a single candidate).
  // For v0.1, we apply rewrites only to Write (full-content rewrites).
  // For Edit / MultiEdit, the rewrite is applied to the new_string of the relevant edit.
  let updated = input;
  for (const candidate of candidates) {
    const myReports = reports.filter((r) => candidates[reports.indexOf(r)] === candidate || candidates.length === 1);
    if (myReports.length === 0) continue;
    let content = candidate.content;
    // Apply highest-line-number first to keep earlier offsets stable.
    const sorted = [...myReports].sort((a, b) =>
      (b.violation.line - a.violation.line) ||
      (b.violation.column - a.violation.column),
    );
    for (const r of sorted) {
      content = replaceAt(content, r.violation, r.renderedReplacement);
    }
    updated = candidate.replaceFn(content);
  }
  return updated;
}

function isTokenSourceFile(file, root) {
  if (!root) return false;
  const norm = file.replace(/\\/g, '/');
  if (norm.endsWith('/tokens.json')) return true;
  if (norm.endsWith('/design-tokens.json')) return true;
  return false;
}

function denyTokenSourceEdit(file) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ui-tokenize] Direct edits to ${file} are not allowed in consumer mode.\n\nTo add a new token, call MCP tool tokenize__propose(value, intent). It returns a temporary __proposed.* name you can use immediately, and queues the proposal for human review.\n\nIf this project should be in maintainer mode, set "mode": "maintainer" in .tokenize/config.json — and even then, only the validated tokenize__add_token / tokenize__deprecate MCP tools may write tokens.json (direct Write/Edit remains blocked to enforce schema and naming rules).`,
    },
  };
}

function denyMaintainerDirectEdit(file) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ui-tokenize] Direct Write/Edit of ${file} is not allowed even in maintainer mode.\n\nUse the validated MCP tools instead:\n  - tokenize__add_token(name, value, type, description)  — adds with DTCG + naming validation\n  - tokenize__deprecate(name, reason, replacement?)       — marks deprecated\n\nThese guarantee schema and naming-convention enforcement that Write/Edit cannot.`,
    },
  };
}

function denyNoCatalog() {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ui-tokenize] No design-token catalog found.\n\nRun /tokenize:init to scaffold one (or /tokenize:init --starter shadcn|material for a curated starter). The plugin cannot suggest replacements until tokens exist.\n\nFor each individual value you want to keep but tokenize, call MCP tool tokenize__propose(value, intent).`,
    },
  };
}

function readConsumerProfile(root) {
  const path = join(tokenizeDir(root), 'consumer-profile.json');
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return undefined; }
}
