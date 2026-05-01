#!/usr/bin/env node
// PostToolUse: re-scan written file; emit Catalog updated when token-source changed;
// run external linters (stylelint/eslint) if installed; report residuals.

import { readSync, readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverCatalog, isCatalogTokenSource, readCatalog, writeCatalog } from '../lib/catalog.mjs';
import { classifySurface, isExemptFile, scan } from '../lib/scanner.mjs';
import { suggest } from '../lib/suggester.mjs';
import { renderToken } from '../lib/render.mjs';
import { catalogUpdatedMessage, postToolReport } from '../lib/format.mjs';
import { isSurfaceAllowed, readConfig } from '../lib/config.mjs';
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
const oldCat = readCatalog(root);

// If ANY discovered token source was edited (DTCG json OR a CSS file with :root vars),
// re-discover and emit catalog-update delta.
if (isCatalogTokenSource(targetFile, oldCat)) {
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

// Otherwise re-scan to surface residuals (catches anything PreToolUse let through).
if (isExemptFile(targetFile)) exitNoOutput();

// Honor the per-project surface allowlist before doing residual work.
const config = readConfig(targetFile);
if (config.disabled) exitNoOutput();
const postSurface = classifySurface(targetFile);
if (config.surfaces !== null && !isSurfaceAllowed(postSurface, config)) exitNoOutput();

// Run external linters first (auto-fix only) if they're installed at the root.
runExternalLinters(targetFile, root);

let content;
try { content = readFileSync(targetFile, 'utf8'); }
catch { exitNoOutput(); }

const catalog = oldCat;
if (!catalog) exitNoOutput();
const profilePath = join(tokenizeDir(root), 'consumer-profile.json');
const profile = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : undefined;
const tailwindDetected = catalog.sources?.some((s) => s.type === 'tailwind') || false;

const violations = scan(content, targetFile, { tailwindDetected, allowedSurfaces: config.surfaces });
if (violations.length === 0) exitNoOutput();

const reports = violations.map((v) => {
  const result = suggest(v, catalog);
  return {
    violation: v,
    primary: result.primary,
    alternates: result.alternates,
    renderedReplacement: result.primary ? renderToken(result.primary.tokenName, v.surface, profile, v) : null,
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

/**
 * Auto-fix the touched file with Stylelint and/or ESLint when those tools are present
 * under <root>/node_modules. Failures are silent — the linter is augmenting, not gating.
 *
 * Resolves binaries directly from `<root>/node_modules/.bin/` rather than going
 * through `npx`. That removes PATH from the trust set (npx would happily pick up a
 * shadowing `eslint` earlier in PATH) and avoids the network-aware npx fallback.
 */
function runExternalLinters(file, projectRoot) {
  const ext = extname(file).toLowerCase();
  if (['.css', '.scss', '.less', '.pcss'].includes(ext)) {
    runLintBin(projectRoot, 'stylelint', ['--fix', file]);
  }
  if (['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs'].includes(ext)) {
    runLintBin(projectRoot, 'eslint', ['--fix', file]);
  }
}

function runLintBin(projectRoot, binName, args) {
  const isWin = process.platform === 'win32';
  const binPath = join(projectRoot, 'node_modules', '.bin', isWin ? `${binName}.cmd` : binName);
  if (!existsSync(binPath)) return;
  try {
    execFileSync(binPath, args, {
      cwd: projectRoot,
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch { /* non-fatal */ }
}
