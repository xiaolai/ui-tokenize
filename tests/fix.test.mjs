// CLI `fix` tests — directory walks, suppressions, ignore-aware globs.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const CLI = join(PLUGIN_ROOT, 'commands', 'cli.mjs');

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-fix-'));
  writeFileSync(join(root, 'package.json'), '{"name":"fix-test"}');
  writeFileSync(join(root, 'tokens.json'), JSON.stringify({
    color: { primary: { $value: '#2563eb', $type: 'color' } },
    space: { 4: { $value: '16px', $type: 'dimension' } },
  }));
  return root;
}

function runCli(args, cwd) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
}

// Regression: `fix <dir>` must walk the directory tree and rewrite nested files.
// Before the require() → statSync fix, the directory branch was never taken
// (statSyncSafe always returned null), so this command was a silent no-op.
// Defends finding #2 (High).
test('fix <directory> rewrites violations in nested files', () => {
  const root = setup();
  try {
    mkdirSync(join(root, 'src', 'nested'), { recursive: true });
    const target = join(root, 'src', 'nested', 'a.css');
    writeFileSync(target, '.btn { color: #2563eb; padding: 16px; }\n');
    const r = runCli(['fix', 'src'], root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const after = readFileSync(target, 'utf8');
    assert.ok(after.includes('var(--color-primary)'), `expected token rewrite, got: ${after}`);
    assert.ok(!after.includes('#2563eb'), `should not contain original literal, got: ${after}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: `fix --suppressions` must skip suppressed files (parity with audit).
// Defends finding #9 (Medium).
test('fix honors --suppressions', () => {
  const root = setup();
  try {
    const target = join(root, 'a.css');
    writeFileSync(target, '.btn { color: #2563eb; }\n');
    writeFileSync(join(root, '.suppress'), 'a.css\n');
    const r = runCli(['fix', '--suppressions', '.suppress'], root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const after = readFileSync(target, 'utf8');
    assert.ok(after.includes('#2563eb'), `suppressed file should not be rewritten, got: ${after}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: `fix` (no glob) walks the repo and respects .gitignore.
// Defends finding #7 (Medium) for the fix path.
test('fix respects .gitignore', () => {
  const root = setup();
  try {
    mkdirSync(join(root, 'generated'), { recursive: true });
    const ignored = join(root, 'generated', 'noisy.css');
    writeFileSync(ignored, '.z { color: #2563eb; }\n');
    writeFileSync(join(root, '.gitignore'), 'generated/\n');
    runCli(['fix'], root);
    const after = readFileSync(ignored, 'utf8');
    assert.ok(after.includes('#2563eb'), `should not have rewritten ignored file, got: ${after}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
