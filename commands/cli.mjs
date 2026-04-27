#!/usr/bin/env node
// Unified CLI used by slash commands and the optional `npx ui-tokenize <subcommand>` entry.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { discoverCatalog, readCatalog, writeCatalog } from '../lib/catalog.mjs';
import { isExemptFile, scan, classifySurface } from '../lib/scanner.mjs';
import { suggest } from '../lib/suggester.mjs';
import { renderToken, replaceAt } from '../lib/render.mjs';
import { findRepoRoot, findTokenRoot, tokenizeDir } from '../lib/paths.mjs';
import { compactLedger, readSession } from '../lib/ledger.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const subcommand = args[0];

try {
  switch (subcommand) {
    case 'init':     await cmdInit(args.slice(1)); break;
    case 'catalog':  await cmdCatalog(args.slice(1)); break;
    case 'audit':    await cmdAudit(args.slice(1)); break;
    case 'fix':      await cmdFix(args.slice(1)); break;
    case 'metrics':  await cmdMetrics(args.slice(1)); break;
    case 'propose':  await cmdPropose(args.slice(1)); break;
    default:
      printUsage();
      process.exit(2);
  }
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
}

// --------------------------------------------------------------------------------
// init
// --------------------------------------------------------------------------------

async function cmdInit(rest) {
  const starterFlag = rest.find((a) => a.startsWith('--starter='));
  const starterName = starterFlag ? starterFlag.split('=')[1] : (rest.includes('--starter') ? rest[rest.indexOf('--starter') + 1] : null);
  const root = findTokenRoot(process.cwd()) || findRepoRoot(process.cwd()) || process.cwd();
  const tokensPath = join(root, 'tokens.json');
  const cssPath = join(root, 'tokens.css');
  const tsPath = join(root, 'tokens.ts');
  const configPath = join(tokenizeDir(root), 'config.json');

  // 1. Discovery first.
  const cat = discoverCatalog(root);
  if (Object.keys(cat.tokens).length > 0) {
    writeCatalog(cat);
    log(`✓ Discovered ${Object.keys(cat.tokens).length} tokens across ${cat.sources.length} sources:`);
    for (const s of cat.sources) log(`  - ${s.type}: ${s.path} (${s.tokenCount} tokens)`);
    log('');
    if (cat.conflicts.length > 0) {
      log(`⚠ ${cat.conflicts.length} conflict(s) — see ${join(tokenizeDir(root), 'conflicts.json')}`);
    }
    log(`Use /tokenize:catalog to inspect, /tokenize:audit to scan for hardcoded values.`);
    if (!existsSync(configPath)) bootstrapConfig(configPath);
    return;
  }

  // 2. Scaffold.
  if (existsSync(tokensPath)) {
    log(`tokens.json exists at ${tokensPath} but contained no tokens. Aborting init to avoid overwriting; edit it manually or remove it first.`);
    return;
  }

  let starter = { $schema: 'https://design-tokens.github.io/community-group/schemas/format/' };
  if (starterName) {
    const starterPath = join(PLUGIN_ROOT, 'starters', `${starterName}.json`);
    if (!existsSync(starterPath)) throw new Error(`unknown starter "${starterName}"; available: ${listStarters().join(', ')}`);
    starter = JSON.parse(readFileSync(starterPath, 'utf8'));
  }
  writeFileSync(tokensPath, JSON.stringify(starter, null, 2));
  log(`✓ Created ${tokensPath}${starterName ? ` from starter "${starterName}"` : ' (empty)'}.`);

  // Re-discover after scaffold.
  const newCat = discoverCatalog(root);
  writeCatalog(newCat);
  generateCss(newCat, cssPath);
  generateTs(newCat, tsPath);
  log(`✓ Generated ${relative(root, cssPath)} and ${relative(root, tsPath)}.`);
  if (!existsSync(configPath)) bootstrapConfig(configPath);
  log('');
  log(`Next: /tokenize:catalog to verify; /tokenize:audit to find hardcoded values to migrate.`);
}

function bootstrapConfig(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ mode: 'consumer' }, null, 2));
  log(`✓ Created ${path} (consumer mode).`);
}

function listStarters() {
  const dir = join(PLUGIN_ROOT, 'starters');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

function generateCss(cat, path) {
  const lines = [':root {'];
  for (const t of Object.values(cat.tokens)) {
    if (t.tier === 'primitive' && t.name.startsWith('primitive.')) continue;
    const cssName = '--' + t.name.replace(/\./g, '-');
    lines.push(`  ${cssName}: ${t.value};${t.description ? `  /* ${t.description} */` : ''}`);
  }
  lines.push('}');
  writeFileSync(path, lines.join('\n') + '\n');
}

function generateTs(cat, path) {
  /** @type {Record<string, any>} */
  const tree = {};
  for (const t of Object.values(cat.tokens)) {
    let node = tree;
    const parts = t.name.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = t.value;
  }
  writeFileSync(path, `// Generated by ui-tokenize. Do not edit by hand.\nexport const tokens = ${JSON.stringify(tree, null, 2)} as const;\nexport type Tokens = typeof tokens;\n`);
}

// --------------------------------------------------------------------------------
// catalog
// --------------------------------------------------------------------------------

async function cmdCatalog(rest) {
  const pattern = rest.find((a) => !a.startsWith('--'));
  const root = findTokenRoot(process.cwd()) || findRepoRoot(process.cwd()) || process.cwd();
  const cat = readCatalog(root) || discoverCatalog(root);
  if (Object.keys(cat.tokens).length === 0) {
    log('No tokens. Run /tokenize:init.');
    return;
  }
  /** @type {Record<string, any[]>} */
  const grouped = {};
  for (const t of Object.values(cat.tokens)) {
    if (pattern && !t.name.includes(pattern)) continue;
    if (!grouped[t.type]) grouped[t.type] = [];
    grouped[t.type].push(t);
  }
  for (const [cat2, items] of Object.entries(grouped)) {
    log(`## ${cat2}`);
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const t of items) {
      const tier = t.tier === 'primitive' ? ' [primitive]' : '';
      const dep = t.deprecated ? ' [DEPRECATED]' : '';
      log(`  ${t.name.padEnd(36)} ${t.value}${tier}${dep}`);
    }
    log('');
  }
}

// --------------------------------------------------------------------------------
// audit
// --------------------------------------------------------------------------------

async function cmdAudit(rest) {
  const flags = parseFlags(rest);
  const root = findTokenRoot(process.cwd()) || findRepoRoot(process.cwd()) || process.cwd();
  const cat = readCatalog(root) || discoverCatalog(root);
  const profile = readConsumerProfileFile(root);
  const tailwindDetected = cat.sources?.some((s) => s.type === 'tailwind') || false;

  const baseline = flags.baseline ?? defaultBaseline();
  const useChangedLines = flags.changedOnly !== false && !flags.fullRepo;
  const changedLineMap = useChangedLines ? changedLineRanges(root, baseline) : null;
  const files = useChangedLines
    ? [...changedLineMap.keys()].map((p) => join(root, p))
    : walkAllFiles(root);

  const suppressions = readSuppressionsFile(flags.suppressions, root);

  /**
   * @typedef {object} Finding
   * @property {string} file
   * @property {any} violation
   * @property {any|null} primary
   * @property {string|null} replacement
   * @property {boolean} preExisting
   * @property {string[]} labels
   */
  /** @type {Finding[]} */
  const findings = [];
  let totalScanned = 0;
  for (const file of files) {
    if (isExemptFile(file)) continue;
    if (!classifySurface(file)) continue;
    if (suppressions.matches(file)) continue;
    totalScanned++;
    let content;
    try { content = readFileSync(file, 'utf8'); }
    catch { continue; }
    const violations = scan(content, file, { tailwindDetected });
    const changedLines = useChangedLines ? changedLineMap.get(relative(root, file)) : null;
    for (const v of violations) {
      const isChanged = !useChangedLines || (changedLines && changedLines.has(v.line));
      if (!isChanged && !flags.allowExisting) continue;
      if (!isChanged) continue;          // never include unchanged findings in changed-only mode
      const result = suggest(v, cat);
      const replacement = result.primary ? renderToken(result.primary.tokenName, v.surface, profile, v) : null;
      findings.push({
        file: relative(root, file),
        violation: v,
        primary: result.primary,
        replacement,
        preExisting: useChangedLines ? false : true,
        labels: ['semantics-unchecked', 'deprecation-unchecked'],
      });
    }
  }

  // Deprecation usage scan (v0.1: name-match only — no AST resolution).
  const deprecatedFindings = flags.failOnDeprecated ? scanDeprecatedUsage(files, cat, root, suppressions) : [];

  // Coverage metric (trend only; never a gate).
  const coverage = computeCoverage(files, suppressions);

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      mode: useChangedLines ? 'changed-only' : 'full-repo',
      baseline,
      filesScanned: totalScanned,
      findings,
      deprecatedUsage: deprecatedFindings,
      coverage,
      coverageDisclaimer: 'Token coverage measures literal-replacement only. Tokens may be semantically wrong or deprecated; see tokenize__deprecate to manage lifecycle.',
    }, null, 2) + '\n');
  } else if (flags.markdown) {
    emitMarkdown({ findings, deprecatedFindings, coverage, totalScanned, useChangedLines, baseline });
  } else {
    log(`Scanned ${totalScanned} files (${useChangedLines ? 'changed-only vs ' + baseline : 'full-repo'}).`);
    log(`Found ${findings.length} hardcoded value(s).`);
    log(`Coverage: ${(coverage.ratio * 100).toFixed(1)}%  (${coverage.tokenized}/${coverage.total} declarations)`);
    log('NOTE: results are tagged semantics-unchecked, deprecation-unchecked. Tokenized ≠ semantically correct.');
    log('');
    for (const f of findings) {
      log(`  ${f.file}:${f.violation.line}  ${f.violation.literal}  →  ${f.replacement ?? '(no match — try tokenize__propose)'}`);
    }
    if (deprecatedFindings.length > 0) {
      log('');
      log(`Deprecated-token usage (${deprecatedFindings.length}):`);
      for (const d of deprecatedFindings) {
        log(`  ${d.file}:${d.line}  ${d.token}  ${d.replacement ? `(use ${d.replacement})` : ''}`);
      }
    }
  }
  // Exit code: gate on findings unless --allow-existing AND we're full-repo (then only
  // changed-line findings would gate, but in full-repo we have none flagged "changed").
  // Plus optional fail-on-deprecated.
  let shouldFail = findings.length > 0;
  if (flags.allowExisting && !useChangedLines) shouldFail = false;
  if (flags.failOnDeprecated && deprecatedFindings.length > 0) shouldFail = true;
  if (shouldFail) process.exit(1);
}

function readSuppressionsFile(path, root) {
  if (!path) return { matches: () => false };
  const abs = resolve(root, path);
  if (!existsSync(abs)) return { matches: () => false };
  let lines;
  try { lines = readFileSync(abs, 'utf8').split(/\r?\n/); }
  catch { return { matches: () => false }; }
  const patterns = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((p) => new RegExp(globToRegexCli(p)));
  return {
    matches(file) {
      const rel = relative(root, file).replace(/\\/g, '/');
      return patterns.some((re) => re.test(rel));
    },
  };
}

function globToRegexCli(pattern) {
  // Local minimal glob → regex (mirror of lib/ignore.mjs behavior, kept inline to avoid
  // an extra import and to keep the audit CLI dependency-free).
  let p = pattern;
  let rooted = false;
  if (p.startsWith('/')) { rooted = true; p = p.slice(1); }
  let r = p.replace(/[.+^${}()|\\]/g, '\\$&');
  r = r.replace(/\*\*/g, '\x00');
  r = r.replace(/\*/g, '[^/]*');
  r = r.replace(/\?/g, '[^/]');
  r = r.replaceAll('\x00', '.*');
  return (rooted ? '^' : '^(?:.*/)?') + r + '(?:/.*)?$';
}

function scanDeprecatedUsage(files, cat, root, suppressions) {
  const deprecated = Object.values(cat.tokens || {}).filter((t) => t.deprecated);
  if (deprecated.length === 0) return [];
  /** @type {Array<{file: string, line: number, token: string, replacement?: string}>} */
  const out = [];
  for (const file of files) {
    if (isExemptFile(file)) continue;
    if (!classifySurface(file)) continue;
    if (suppressions.matches(file)) continue;
    let content;
    try { content = readFileSync(file, 'utf8'); }
    catch { continue; }
    const lines = content.split(/\r?\n/);
    for (const tok of deprecated) {
      const cssName = '--' + tok.name.replace(/\./g, '-');
      const dotName = tok.name;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(cssName) || lines[i].includes(dotName)) {
          out.push({
            file: relative(root, file),
            line: i + 1,
            token: tok.name,
            replacement: extractReplacementHint(tok.description),
          });
        }
      }
    }
  }
  return out;
}

function extractReplacementHint(desc) {
  if (!desc) return undefined;
  const m = /use\s+([a-z][a-z0-9.-]+)/i.exec(desc);
  return m ? m[1] : undefined;
}

/**
 * Trend coverage metric: count CSS-style declarations using tokens vs literals.
 * Indicative only; the disclaimer in the audit output makes this clear.
 */
function computeCoverage(files, suppressions) {
  const declRe = /(?:color|background(?:-color)?|fill|stroke|padding(?:-\w+)?|margin(?:-\w+)?|gap|border-radius|font-size|width|height)\s*:\s*([^;]+);/g;
  let total = 0, tokenized = 0;
  for (const file of files) {
    if (isExemptFile(file)) continue;
    if (!classifySurface(file)) continue;
    if (suppressions.matches(file)) continue;
    let content;
    try { content = readFileSync(file, 'utf8'); }
    catch { continue; }
    let m;
    declRe.lastIndex = 0;
    while ((m = declRe.exec(content))) {
      const value = m[1].trim();
      total++;
      if (/var\(--|tokens\.|theme\.|vars\.|^\$[a-z]/.test(value)) tokenized++;
    }
  }
  return { total, tokenized, ratio: total ? tokenized / total : 1 };
}

function emitMarkdown(payload) {
  const { findings, deprecatedFindings, coverage, totalScanned, useChangedLines, baseline } = payload;
  log('# ui-tokenize audit');
  log('');
  log(`- Mode: ${useChangedLines ? 'changed-only' : 'full-repo'}${useChangedLines ? ` (vs \`${baseline}\`)` : ''}`);
  log(`- Files scanned: ${totalScanned}`);
  log(`- Findings: ${findings.length}`);
  log(`- Coverage: ${(coverage.ratio * 100).toFixed(1)}% (${coverage.tokenized}/${coverage.total})`);
  log(`- Labels: \`semantics-unchecked\`, \`deprecation-unchecked\` — tokenized ≠ semantically correct.`);
  if (findings.length > 0) {
    log('');
    log('## Findings');
    log('');
    log('| File | Line | Type | Literal | Suggestion |');
    log('|------|------|------|---------|------------|');
    for (const f of findings) {
      log(`| \`${f.file}\` | ${f.violation.line} | ${f.violation.type} | \`${f.violation.literal}\` | ${f.replacement ? `\`${f.replacement}\`` : '_(no match — `tokenize__propose`)_'} |`);
    }
  }
  if (deprecatedFindings.length > 0) {
    log('');
    log('## Deprecated-token usage');
    log('');
    log('| File | Line | Token | Replacement |');
    log('|------|------|-------|-------------|');
    for (const d of deprecatedFindings) {
      log(`| \`${d.file}\` | ${d.line} | \`${d.token}\` | ${d.replacement ? `\`${d.replacement}\`` : '_n/a_'} |`);
    }
  }
}

function defaultBaseline() {
  try {
    const remoteHead = execSync('git rev-parse --verify origin/main', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (remoteHead) return 'origin/main';
  } catch { /* fall through */ }
  return 'main';
}

/**
 * Resolve a map of file → Set<line numbers> for lines added/modified vs baseline.
 * Includes both committed differences AND working-tree changes (uncommitted edits).
 *
 * @param {string} root
 * @param {string} baseline
 * @returns {Map<string, Set<number>>}
 */
function changedLineRanges(root, baseline) {
  /** @type {Map<string, Set<number>>} */
  const out = new Map();
  let diff;
  try {
    // `<baseline>` (no `...HEAD`) covers committed + working-tree changes.
    diff = execSync(`git diff --unified=0 --no-color ${baseline} -- .`, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch (err) {
    process.stderr.write(`[ui-tokenize] WARN: cannot diff against ${baseline}: ${err.message}\nFalling back to full-repo scan.\n`);
    // Fall through with empty map — caller treats this as full-repo.
    return new Map();
  }
  let currentFile = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length);
      if (!out.has(currentFile)) out.set(currentFile, new Set());
    } else if (line.startsWith('@@') && currentFile) {
      // Hunk header: @@ -old,oldCount +new,newCount @@
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (!m) continue;
      const start = parseInt(m[1], 10);
      const count = m[2] != null ? parseInt(m[2], 10) : 1;
      const set = out.get(currentFile);
      for (let i = 0; i < count; i++) set.add(start + i);
    }
  }
  return out;
}

function walkAllFiles(root) {
  /** @type {string[]} */
  const out = [];
  walkDir(root, root, out);
  return out;
}

function walkDir(dir, root, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.tokenize'].includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (existsSync(join(full, 'package.json')) && full !== root) continue;
      walkDir(full, root, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
}

// --------------------------------------------------------------------------------
// fix
// --------------------------------------------------------------------------------

async function cmdFix(rest) {
  const root = findTokenRoot(process.cwd()) || findRepoRoot(process.cwd()) || process.cwd();
  const cat = readCatalog(root) || discoverCatalog(root);
  const profile = readConsumerProfileFile(root);
  const tailwindDetected = cat.sources?.some((s) => s.type === 'tailwind') || false;
  const glob = rest.find((a) => !a.startsWith('--'));
  const files = glob ? expandGlob(glob, root) : walkAllFiles(root);

  let modifiedCount = 0;
  let replacementCount = 0;
  for (const file of files) {
    if (isExemptFile(file)) continue;
    if (!classifySurface(file)) continue;
    let content;
    try { content = readFileSync(file, 'utf8'); }
    catch { continue; }
    const violations = scan(content, file, { tailwindDetected });
    const exact = violations
      .map((v) => ({ v, s: suggest(v, cat) }))
      .filter((x) => x.s.primary && x.s.primary.confidence === 1.0);
    if (exact.length === 0) continue;
    const sorted = [...exact].sort((a, b) =>
      (b.v.line - a.v.line) || (b.v.column - a.v.column),
    );
    let next = content;
    for (const x of sorted) {
      const replacement = renderToken(x.s.primary.tokenName, x.v.surface, profile, x.v);
      next = replaceAt(next, x.v, replacement);
      replacementCount++;
    }
    if (next !== content) {
      writeFileSync(file, next);
      modifiedCount++;
      log(`  fixed ${exact.length} in ${relative(root, file)}`);
    }
  }
  log('');
  log(`Done. ${replacementCount} exact-match rewrite(s) across ${modifiedCount} file(s).`);
}

function expandGlob(pattern, root) {
  // Minimal glob: full path, directory, or simple wildcard. For richer globs, document `find` usage.
  const path = resolve(root, pattern);
  if (existsSync(path)) {
    const stats = statSyncSafe(path);
    if (stats?.isDirectory()) {
      const out = [];
      walkDir(path, root, out);
      return out;
    }
    return [path];
  }
  return [];
}

function statSyncSafe(p) {
  try { return require('node:fs').statSync(p); }
  catch { return null; }
}

// --------------------------------------------------------------------------------
// metrics
// --------------------------------------------------------------------------------

async function cmdMetrics(_rest) {
  const root = findTokenRoot(process.cwd()) || findRepoRoot(process.cwd()) || process.cwd();
  // Compact first to ensure we read the latest data.
  try { compactLedger(root, `metrics_${Date.now()}`); } catch { /* not fatal */ }
  const session = readSession(root);
  if (!session) {
    log('No session ledger yet.');
    return;
  }
  log(`Session ${session.sessionId}`);
  log(`  started: ${session.startedAt}`);
  log(`  updated: ${session.updatedAt}`);
  log(`  metrics: ${JSON.stringify(session.metrics)}`);
  if (session.fabrications.length) {
    log(`  fabrications:`);
    for (const f of session.fabrications) log(`    - ${f.name}${f.real ? ` (real: ${f.real})` : ''}`);
  }
  if (Object.keys(session.unresolvedByFile).length) {
    log(`  unresolved by file:`);
    for (const [f, n] of Object.entries(session.unresolvedByFile)) log(`    - ${f}: ${n}`);
  }
}

// --------------------------------------------------------------------------------
// propose (slash-command wrapper)
// --------------------------------------------------------------------------------

async function cmdPropose(rest) {
  const value = rest[0];
  const intent = rest.slice(1).join(' ');
  if (!value || !intent) {
    log('Usage: /tokenize:propose <value> "<intent>"');
    process.exit(2);
  }
  const root = findTokenRoot(process.cwd()) || findRepoRoot(process.cwd()) || process.cwd();
  const proposalsPath = join(root, 'tokens.proposed.json');
  const existing = existsSync(proposalsPath) ? JSON.parse(readFileSync(proposalsPath, 'utf8')) : { proposals: [] };
  const tempName = `__proposed.${kebabToCamel(intent)}`;
  const id = `prop_${new Date().toISOString().slice(0, 10)}_${String(existing.proposals.length + 1).padStart(3, '0')}`;
  existing.proposals.push({
    id,
    value,
    intent,
    proposedTokenName: nameFromIntent(intent, value),
    timestamp: new Date().toISOString(),
    status: 'pending',
    tempName,
  });
  writeFileSync(proposalsPath, JSON.stringify(existing, null, 2));
  log(`✓ Proposed ${id}.`);
  log(`  value: ${value}`);
  log(`  intent: ${intent}`);
  log(`  use the temporary name: ${tempName}`);
  log(`  file: ${proposalsPath}`);
}

function kebabToCamel(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[^a-z]/, '');
}

function nameFromIntent(intent, value) {
  const isColor = /#|rgb|hsl/.test(value);
  const isDim = /\d+(px|rem|em|ch|vw|vh|%)$/.test(value);
  const cat = isColor ? 'color' : isDim ? 'space' : 'token';
  return `${cat}.${String(intent).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

// --------------------------------------------------------------------------------
// shared
// --------------------------------------------------------------------------------

function parseFlags(rest) {
  const flags = {
    json: false,
    markdown: false,
    fullRepo: false,
    changedOnly: true,
    baseline: null,
    fix: false,
    allowExisting: false,
    suppressions: null,
    failOnDeprecated: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') flags.json = true;
    else if (a === '--markdown') flags.markdown = true;
    else if (a === '--full-repo') { flags.fullRepo = true; flags.changedOnly = false; }
    else if (a === '--changed-only') flags.changedOnly = true;
    else if (a === '--baseline') flags.baseline = rest[++i];
    else if (a.startsWith('--baseline=')) flags.baseline = a.split('=')[1];
    else if (a === '--fix') flags.fix = true;
    else if (a === '--allow-existing') flags.allowExisting = true;
    else if (a === '--suppressions') flags.suppressions = rest[++i];
    else if (a.startsWith('--suppressions=')) flags.suppressions = a.split('=')[1];
    else if (a === '--fail-on-deprecated') flags.failOnDeprecated = true;
  }
  return flags;
}

function readConsumerProfileFile(root) {
  const path = join(tokenizeDir(root), 'consumer-profile.json');
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return undefined; }
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

function printUsage() {
  process.stdout.write([
    'Usage: ui-tokenize <subcommand> [options]',
    '',
    'Subcommands:',
    '  init [--starter <name>]                Discover or scaffold tokens',
    '  catalog [<pattern>]                    Print the live catalog',
    '  audit [--changed-only|--full-repo] [--baseline <ref>] [--json]',
    '                                         Scan for hardcoded values',
    '  fix [<glob>]                           Apply exact-match rewrites in place',
    '  metrics                                Print session ledger',
    '  propose <value> "<intent>"             Queue a token proposal',
    '',
  ].join('\n'));
}
