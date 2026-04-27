// Audit CLI tests — full-repo, changed-only, suppressions, fail-on-deprecated, markdown.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const CLI = join(PLUGIN_ROOT, 'commands', 'cli.mjs');

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-audit-'));
  // Initialize a git repo so changed-only flow has a baseline.
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 't@t.x'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'package.json'), '{"name":"audit-test"}');
  writeFileSync(join(root, 'tokens.json'), JSON.stringify({
    color: { primary: { $value: '#2563eb', $type: 'color' } },
    space: { 4: { $value: '16px', $type: 'dimension' } },
  }));
  // Trailing newline is important: without it, appending creates a no-newline-at-end
  // marker in the diff that git treats as line-1-changed too.
  writeFileSync(join(root, 'a.css'), `.x { color: #ff0000; padding: 99px; }\n`);
  spawnSync('git', ['add', '-A'], { cwd: root });
  // -c flags must come BEFORE the subcommand for git CLI.
  spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial'], { cwd: root });
  return root;
}

function runCli(args, cwd) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
}

test('audit --full-repo reports all violations', () => {
  const root = setup();
  try {
    const r = runCli(['audit', '--full-repo'], root);
    assert.equal(r.status, 1, `expected non-zero exit, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('#ff0000'), `should report #ff0000, got: ${r.stdout}`);
    assert.ok(r.stdout.includes('99px'), `should report 99px, got: ${r.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit --changed-only filters to changed lines vs baseline', () => {
  const root = setup();
  try {
    // Add ONE new line; should not flag pre-existing #ff0000 / 99px on lines 1-1.
    appendFileSync(join(root, 'a.css'), '\n.y { color: #abcdef; }');
    const r = runCli(['audit', '--changed-only', '--baseline', 'HEAD'], root);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('#abcdef'), `should report #abcdef, got: ${r.stdout}`);
    assert.ok(!r.stdout.includes('#ff0000'), `should NOT report pre-existing #ff0000, got: ${r.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit --json emits structured payload with labels and coverage', () => {
  const root = setup();
  try {
    const r = runCli(['audit', '--full-repo', '--json'], root);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.mode, 'full-repo');
    assert.ok(Array.isArray(payload.findings));
    assert.ok(payload.findings.length >= 2);
    assert.ok(payload.findings[0].labels.includes('semantics-unchecked'));
    assert.ok(payload.findings[0].labels.includes('deprecation-unchecked'));
    assert.ok('coverage' in payload);
    assert.ok('coverageDisclaimer' in payload);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit --markdown emits markdown table', () => {
  const root = setup();
  try {
    const r = runCli(['audit', '--full-repo', '--markdown'], root);
    assert.ok(r.stdout.includes('# ui-tokenize audit'), `should have markdown header, got: ${r.stdout}`);
    assert.ok(r.stdout.includes('| File | Line | Type | Literal | Suggestion |'));
    assert.ok(r.stdout.includes('| `a.css` |'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit --suppressions skips matched files', () => {
  const root = setup();
  try {
    writeFileSync(join(root, '.tokenize-suppress'), 'a.css\n');
    const r = runCli(['audit', '--full-repo', '--suppressions', '.tokenize-suppress'], root);
    assert.equal(r.status, 0, `should pass when suppressed, got stdout: ${r.stdout}, stderr: ${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit reports coverage metric in default output', () => {
  const root = setup();
  try {
    const r = runCli(['audit', '--full-repo'], root);
    assert.ok(/Coverage:\s*[\d.]+%/.test(r.stdout), `should report coverage, got: ${r.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
