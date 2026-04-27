#!/usr/bin/env node
// SessionStart hook: rebuild catalog, compact ledger, inject categorized token list.

import { readSync } from 'node:fs';
import { discoverCatalog, writeCatalog } from '../lib/catalog.mjs';
import { discoverConsumerProfile } from '../lib/consumer-profile.mjs';
import { compactLedger } from '../lib/ledger.mjs';
import { findRepoRoot, findTokenRoot, tokenizeDir } from '../lib/paths.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const stdinBuf = readAllStdin();
let event;
try { event = JSON.parse(stdinBuf); } catch { event = {}; }

const cwd = event.cwd || process.cwd();
const root = findTokenRoot(cwd) || findRepoRoot(cwd) || cwd;
const sessionId = event.session_id || `sess_${Date.now()}`;

let catalog, profile;
try {
  catalog = discoverCatalog(root);
  writeCatalog(catalog);
} catch (err) {
  process.stderr.write(`[ui-tokenize] WARN: discovery failed: ${err.message}\n`);
  catalog = null;
}

try {
  profile = discoverConsumerProfile(root);
  const profilePath = join(tokenizeDir(root), 'consumer-profile.json');
  mkdirSync(join(tokenizeDir(root)), { recursive: true });
  writeFileSync(profilePath, JSON.stringify(profile, null, 2));
} catch {
  profile = null;
}

try { compactLedger(root, sessionId); } catch { /* ledger optional */ }

const injection = formatInjection(catalog, profile, root);
const output = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: injection,
  },
};
process.stdout.write(JSON.stringify(output));
process.exit(0);

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

function formatInjection(cat, prof, projectRoot) {
  if (!cat || Object.keys(cat.tokens).length === 0) {
    return [
      '# ui-tokenize',
      '',
      `No design tokens were discovered in ${projectRoot}.`,
      'Run /tokenize:init to scaffold a token system, or /tokenize:init --starter shadcn for a curated set.',
      'Until tokens exist, hardcoded UI values cannot be auto-rewritten.',
    ].join('\n');
  }
  const grouped = groupByCategory(cat.tokens);
  const lines = [
    `# ui-tokenize — design-token catalog (live, generated ${cat.generatedAt})`,
    `# Sources: ${cat.sources.map((s) => `${s.type} (${s.tokenCount})`).join(', ')}`,
    '# Use these tokens; do not emit hardcoded UI values. The PreToolUse hook will rewrite exact-value matches automatically.',
    '# When no token fits: call MCP tool tokenize__propose(value, intent).',
    '',
  ];
  if (prof) lines.push(...formatConsumerProfile(prof));
  for (const [cat2, items] of Object.entries(grouped)) {
    lines.push(`## ${cat2}`);
    for (const t of items) {
      const desc = t.description ? `  (${t.description})` : '';
      const dep = t.deprecated ? '  [DEPRECATED]' : '';
      lines.push(`- ${t.name.padEnd(36)} ${t.value}${desc}${dep}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatConsumerProfile(p) {
  const out = ['## observed token-reference conventions'];
  for (const [surface, info] of Object.entries(p.surfaces)) {
    if (info.confidence === 'none') continue;
    out.push(`- ${surface}: ${info.convention} (${info.confidence}, ${info.samples} samples)`);
  }
  out.push('');
  return out;
}

function groupByCategory(tokens) {
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const t of Object.values(tokens)) {
    if (t.tier === 'primitive') continue;
    const cat = t.type || 'other';
    if (!out[cat]) out[cat] = [];
    out[cat].push(t);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
