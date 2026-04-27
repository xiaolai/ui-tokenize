#!/usr/bin/env node
// PostToolUse: re-scan written file; emit Catalog updated when token-source changed; report residuals.

import { readSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverCatalog, readCatalog, writeCatalog } from '../lib/catalog.mjs';
import { isExemptFile, scan } from '../lib/scanner.mjs';
import { suggest } from '../lib/suggester.mjs';
import { renderToken } from '../lib/render.mjs';
import { catalogUpdatedMessage, postToolReport } from '../lib/format.mjs';
import { findRepoRoot, findTokenRoot, tokenizeDir } from '../lib/paths.mjs';

const stdinBuf = readAllStdin();
let event;
try { event = JSON.parse(stdinBuf); } catch { exitNoOutput(); }

const toolName = event.tool_name;
const toolInput = event.tool_input || {};
if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) exitNoOutput();

const targetFile = toolInput.file_path || toolInput.path;
if (!targetFile) exitNoOutput();

const root = findTokenRoot(targetFile) || findRepoRoot(targetFile) || process.cwd();

// If a token-source file was edited, re-discover and emit delta.
if (/\/(tokens|design-tokens)\.json$/.test(targetFile.replace(/\\/g, '/'))) {
  const oldCat = readCatalog(root);
  let newCat;
  try {
    newCat = discoverCatalog(root);
    writeCatalog(newCat);
  } catch (err) {
    process.stderr.write(`[ui-tokenize] WARN: post-write re-discovery failed: ${err.message}\n`);
    exitNoOutput();
  }
  const delta = diffCatalogs(oldCat, newCat);
  emit(catalogUpdatedMessage(delta));
}

// Otherwise re-scan to surface residuals (catches anything PreToolUse let through, e.g. on Edit context).
if (isExemptFile(targetFile)) exitNoOutput();
let content;
try { content = readFileSync(targetFile, 'utf8'); }
catch { exitNoOutput(); }

const catalog = readCatalog(root);
if (!catalog) exitNoOutput();
const profilePath = join(tokenizeDir(root), 'consumer-profile.json');
const profile = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : undefined;
const tailwindDetected = catalog.sources?.some((s) => s.type === 'tailwind') || false;

const violations = scan(content, targetFile, { tailwindDetected });
if (violations.length === 0) exitNoOutput();

const reports = violations.map((v) => {
  const result = suggest(v, catalog);
  return {
    violation: v,
    primary: result.primary,
    alternates: result.alternates,
    renderedReplacement: result.primary ? renderToken(result.primary.tokenName, v.surface, profile) : null,
  };
});
emit(postToolReport(reports));

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

function exitNoOutput() {
  process.exit(0);
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

function diffCatalogs(oldC, newC) {
  if (!oldC) return { added: Object.keys(newC.tokens), removed: [], renamed: [] };
  const oldNames = new Set(Object.keys(oldC.tokens));
  const newNames = new Set(Object.keys(newC.tokens));
  const added = [...newNames].filter((n) => !oldNames.has(n));
  const removed = [...oldNames].filter((n) => !newNames.has(n));
  return { added, removed, renamed: [] };
}
