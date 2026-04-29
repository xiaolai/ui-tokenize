#!/usr/bin/env node
// PreToolUse hook: rewrite-first on confidence-1.0 (D-018);
// deny with structured suggestions otherwise; hard-stop after 2 unresolved blocks per file (D-019).

import { readSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCatalogSourceType, readCatalog } from '../lib/catalog.mjs';
import { isExemptFile, scan } from '../lib/scanner.mjs';
import { suggest } from '../lib/suggester.mjs';
import { renderToken, replaceAt } from '../lib/render.mjs';
import { allowRewrite, denyWithSuggestions, hardStop } from '../lib/format.mjs';
import { appendEvent, consecutiveDeniesFor } from '../lib/ledger.mjs';
import { readConfig } from '../lib/config.mjs';
import { findRepoRoot, findTokenRoot, tokenizeDir } from '../lib/paths.mjs';

// D-019: deny-deny-deny → hard-stop. Three consecutive deny outcomes for the same file
// in the current session before this PreToolUse triggers HARD_STOP. Resolved by any
// successful tool call (rewrite or passthrough) on the same file.
const HARD_STOP_THRESHOLD = 3;

const stdinBuf = readAllStdin();
let event;
try { event = JSON.parse(stdinBuf); } catch { failClosed('malformed hook event'); }

const sessionId = event.session_id || 'unknown';
const toolName = event.tool_name;
const toolInput = event.tool_input || {};

if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) passthrough('unmatched tool');

const targetFile = resolveTargetFile(toolInput);
if (!targetFile) passthrough('no resolvable file path');

const root = findTokenRoot(targetFile) || findRepoRoot(targetFile) || process.cwd();
const config = readConfig(targetFile);
if (config.disabled) passthrough('plugin disabled in config');

// Block direct edits to ANY discovered token source (DTCG JSON, CSS root vars, etc.)
// BEFORE the exempt-file check (which would otherwise pass-through tokens.json as a
// "non-violation surface"). The catalog is the source of truth for what counts.
const catalog = readCatalog(root);
const sourceType = getCatalogSourceType(targetFile, catalog);
if (sourceType) {
  if (config.mode !== 'maintainer') {
    emit(denyTokenSourceEdit(targetFile));
  }
  // Maintainer mode: only DTCG sources need the validated MCP path
  // (tokenize__add_token / tokenize__deprecate). css-vars and other
  // free-form sources have no structural schema to enforce, so direct
  // edits are the practical path for additions and bulk system
  // migrations. tokens.json keeps the deny-direct-edit policy because
  // that's where schema enforcement actually matters.
  if (sourceType === 'dtcg-json') {
    emit(denyMaintainerDirectEdit(targetFile));
  }
  passthrough(`maintainer mode, ${sourceType} source`);
}

if (isExemptFile(targetFile)) passthrough('exempt file');

if (!catalog || Object.keys(catalog.tokens).length === 0) {
  emit(denyNoCatalog());
}

const profile = readConsumerProfile(root);
const tailwindDetected = catalog?.sources?.some((s) => s.type === 'tailwind') || false;

const candidates = collectEditedContents(toolInput, toolName);
/** @type {Array<{candidateIdx: number, report: import('../lib/format.mjs').ViolationReport}>} */
const allReports = [];
for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i];
  const violations = scan(c.content, targetFile, { tailwindDetected });
  for (const v of violations) {
    const result = suggest(v, catalog);
    const replacement = result.primary
      ? renderToken(result.primary.tokenName, v.surface, profile, v)
      : null;
    allReports.push({
      candidateIdx: i,
      report: {
        violation: v,
        primary: result.primary,
        alternates: result.alternates,
        renderedReplacement: replacement,
      },
    });
  }
}

if (allReports.length === 0) {
  // No violations — successful outcome resets the budget for this file/session.
  appendEvent(targetFile, { kind: 'resolve', sessionId, file: targetFile });
  passthrough('no violations');
}

// Partition: confidence-1.0 with a rendered replacement = rewrite; everything else = deny.
const rewrites = allReports.filter((x) =>
  x.report.primary && x.report.primary.confidence === 1.0 && x.report.renderedReplacement,
);
const denies = allReports.filter((x) => !rewrites.includes(x));

if (rewrites.length > 0 && denies.length === 0) {
  // All exact matches → rewrite and allow.
  const updatedInput = applyRewritesPerCandidate(toolInput, toolName, candidates, rewrites);
  for (const x of rewrites) {
    appendEvent(targetFile, {
      kind: 'rewrite',
      sessionId,
      file: targetFile,
      line: x.report.violation.line,
      literal: x.report.violation.literal,
      token: x.report.primary.tokenName,
    });
  }
  // A successful rewrite is also a budget-resetting outcome.
  appendEvent(targetFile, { kind: 'resolve', sessionId, file: targetFile });
  emit(allowRewrite(updatedInput, rewrites.map((x) => x.report)));
}

// Mixed or all-denies → check budget, emit deny.
const denyCount = consecutiveDeniesFor(targetFile, targetFile, sessionId);
if (denyCount >= HARD_STOP_THRESHOLD) {
  emit(hardStop(`Three consecutive denied tool calls already exist for ${targetFile} in this session; further edits to this file are blocked until they are addressed via tokenize__propose or manual fix.`));
}

// Per-violation block events for metrics; one deny event per (tool-call, file) for the budget.
for (const x of denies) {
  appendEvent(targetFile, {
    kind: 'block',
    sessionId,
    file: targetFile,
    line: x.report.violation.line,
    literal: x.report.violation.literal,
    reason: x.report.primary ? `low-confidence-${x.report.primary.tokenName}` : 'no-match',
  });
}
appendEvent(targetFile, {
  kind: 'deny',
  sessionId,
  file: targetFile,
  reason: `${denies.length} unresolved violation(s)`,
});

emit(denyWithSuggestions(denies.map((x) => x.report), { retryAttempt: denyCount, mode: config.mode }));

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

// Fail closed: deny when we cannot make a security decision (e.g. corrupted or
// attacker-influenced stdin). Allowing the call here is exactly the wrong default
// for a quality/safety gate — the right move is to refuse and surface the cause.
function failClosed(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ui-tokenize] ${reason}; refusing to make a security decision. Re-run the tool call with valid hook input or disable the plugin.`,
    },
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
 * For Write: full content (one candidate).
 * For Edit: the new_string (one candidate).
 * For MultiEdit: each edit's new_string (N candidates).
 *
 * @returns {Array<{content: string}>}
 */
function collectEditedContents(input, tool) {
  if (tool === 'Write') {
    return [{ content: String(input.content ?? '') }];
  }
  if (tool === 'Edit') {
    return [{ content: String(input.new_string ?? '') }];
  }
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.map((e) => ({ content: String(e.new_string ?? '') }));
  }
  return [];
}

/**
 * Apply rewrites to the original tool input by collecting per-candidate replacements
 * and emitting a single accumulated updatedInput. Avoids the bug where rebuilding from
 * input.edits inside a loop overwrites prior per-edit mutations.
 *
 * @param {object} input
 * @param {string} tool
 * @param {Array<{content: string}>} candidates
 * @param {Array<{candidateIdx: number, report: import('../lib/format.mjs').ViolationReport}>} rewrites
 * @returns {object}
 */
function applyRewritesPerCandidate(input, tool, candidates, rewrites) {
  // Group rewrites by candidate index.
  /** @type {Map<number, Array<{candidateIdx: number, report: import('../lib/format.mjs').ViolationReport}>>} */
  const byIdx = new Map();
  for (const r of rewrites) {
    if (!byIdx.has(r.candidateIdx)) byIdx.set(r.candidateIdx, []);
    byIdx.get(r.candidateIdx).push(r);
  }
  // For each candidate, apply its rewrites in descending line/column order to keep
  // earlier offsets stable.
  /** @type {Map<number, string>} */
  const newContents = new Map();
  for (const [idx, group] of byIdx) {
    let content = candidates[idx].content;
    const sorted = [...group].sort((a, b) =>
      (b.report.violation.line - a.report.violation.line) ||
      (b.report.violation.column - a.report.violation.column),
    );
    for (const r of sorted) {
      content = replaceAt(content, r.report.violation, r.report.renderedReplacement);
    }
    newContents.set(idx, content);
  }
  // Reconstruct the tool input atomically with all candidate updates applied.
  if (tool === 'Write') {
    return { ...input, content: newContents.get(0) ?? input.content };
  }
  if (tool === 'Edit') {
    return { ...input, new_string: newContents.get(0) ?? input.new_string };
  }
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const nextEdits = edits.map((e, i) => (
      newContents.has(i) ? { ...e, new_string: newContents.get(i) } : e
    ));
    return { ...input, edits: nextEdits };
  }
  return input;
}

function denyTokenSourceEdit(file) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[ui-tokenize] Direct edits to ${file} are not allowed in consumer mode.\n\nTo add a new token, call MCP tool tokenize__propose(value, intent). It returns a temporary __proposed.* name you can use immediately, and queues the proposal for human review.\n\nIf this project should be in maintainer mode, set "mode": "maintainer" in .tokenize/config.json. css-vars sources (e.g. theme.css) then allow direct edits — useful for system migrations. DTCG token files (tokens.json) still require the validated tokenize__add_token / tokenize__deprecate MCP tools to enforce schema and naming rules.`,
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
