// review-prep CLI tests — surface gating, catalog resolution, context capture,
// changed-lines filter, deprecation flagging, empty-catalog refusal.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const CLI = join(PLUGIN_ROOT, 'commands', 'cli.mjs');

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-review-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 't@t.x'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, 'package.json'), '{"name":"review-test"}');
  writeFileSync(join(root, 'tokens.json'), JSON.stringify({
    color: {
      primary: { $value: '#2563eb', $type: 'color', $description: 'Brand primary; CTAs and links.' },
      danger:  { $value: '#b91c1c', $type: 'color', $description: 'Destructive UI; errors only.' },
      legacy:  { $value: '#999999', $type: 'color', $description: 'Use color.muted instead.', $deprecated: true },
    },
  }));
  return root;
}

function commit(root) {
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial'], { cwd: root });
}

function runCli(args, cwd) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
}

function parseJson(stdout) {
  try { return JSON.parse(stdout); }
  catch (err) { throw new Error(`stdout was not valid JSON: ${err.message}\n${stdout}`); }
}

test('review-prep: emits JSON shape with mode, filesScanned, usagesFound, usages[]', () => {
  const root = setup();
  try {
    writeFileSync(join(root, 'a.css'), '.btn { color: var(--color-primary); }\n');
    commit(root);
    const r = runCli(['review-prep', '--full-repo'], root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const data = parseJson(r.stdout);
    assert.equal(data.mode, 'full-repo');
    assert.equal(typeof data.filesScanned, 'number');
    assert.equal(typeof data.usagesFound, 'number');
    assert.ok(Array.isArray(data.usages));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review-prep: resolves var(--color-primary) → color.primary in CSS', () => {
  const root = setup();
  try {
    writeFileSync(join(root, 'a.css'), '.btn {\n  color: var(--color-primary);\n}\n');
    commit(root);
    const r = runCli(['review-prep', '--full-repo'], root);
    const data = parseJson(r.stdout);
    assert.equal(data.usagesFound, 1);
    const u = data.usages[0];
    assert.equal(u.file, 'a.css');
    assert.equal(u.tokenName, 'color.primary');
    assert.equal(u.tokenValue, '#2563eb');
    assert.equal(u.tokenType, 'color');
    assert.equal(u.tokenDescription, 'Brand primary; CTAs and links.');
    assert.equal(u.kind, 'css-var');
    assert.equal(u.literal, 'var(--color-primary)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review-prep: resolves tokens.color.danger in TSX', () => {
  const root = setup();
  try {
    writeFileSync(
      join(root, 'Banner.tsx'),
      'export function Banner() {\n  return <div style={{ color: tokens.color.danger }}>oops</div>;\n}\n',
    );
    commit(root);
    const r = runCli(['review-prep', '--full-repo'], root);
    const data = parseJson(r.stdout);
    assert.equal(data.usagesFound, 1, JSON.stringify(data.usages));
    assert.equal(data.usages[0].tokenName, 'color.danger');
    assert.equal(data.usages[0].kind, 'js-tokens');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review-prep: surface gating — tokens.foo in HTML body text is NOT a usage', () => {
  const root = setup();
  try {
    // HTML body text mentioning a "tokens.color.danger" string must not
    // become a finding. Surface gating restricts js-tokens pattern to TS/TSX.
    writeFileSync(
      join(root, 'docs.html'),
      '<p>Use tokens.color.danger for errors and tokens.color.primary for CTAs.</p>\n',
    );
    commit(root);
    const r = runCli(['review-prep', '--full-repo'], root);
    const data = parseJson(r.stdout);
    assert.equal(data.usagesFound, 0, `expected no findings, got: ${JSON.stringify(data.usages)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review-prep: ignores token references not present in the catalog', () => {
  const root = setup();
  try {
    // var(--color-imaginary) doesn't resolve to any catalog token. The finder
    // must skip it silently — it's not the reviewer's job to detect that.
    writeFileSync(join(root, 'a.css'), '.x { color: var(--color-imaginary); }\n');
    commit(root);
    const r = runCli(['review-prep', '--full-repo'], root);
    const data = parseJson(r.stdout);
    assert.equal(data.usagesFound, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review-prep: surfaces deprecated tokens with tokenDeprecated:true', () => {
  const root = setup();
  try {
    writeFileSync(join(root, 'a.css'), '.old { color: var(--color-legacy); }\n');
    commit(root);
    const r = runCli(['review-prep', '--full-repo'], root);
    const data = parseJson(r.stdout);
    assert.equal(data.usagesFound, 1);
    assert.equal(data.usages[0].tokenName, 'color.legacy');
    assert.equal(data.usages[0].tokenDeprecated, true);
    assert.match(data.usages[0].tokenDescription, /color\.muted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review-prep: captures surrounding context lines', () => {
  const root = setup();
  try {
    // Place the var() on line 5; expect ~9 lines of context (4 before + match + 4 after).
    writeFileSync(
      join(root, 'a.css'),
      [
        '/* line 1 */',
        '/* line 2 */',
        '/* line 3 */',
        '/* line 4 */',
        '.btn { color: var(--color-primary); }',
        '/* line 6 */',
        '/* line 7 */',
        '/* line 8 */',
        '/* line 9 */',
        '',
      ].join('\n'),
    );
    commit(root);
    const r = runCli(['review-prep', '--full-repo'], root);
    const data = parseJson(r.stdout);
    const u = data.usages[0];
    assert.equal(u.line, 5);
    assert.ok(u.context.length >= 7, `expected at least 7 context lines, got ${u.context.length}`);
    assert.ok(u.context.includes('/* line 1 */'));
    assert.ok(u.context.includes('/* line 9 */'));
    assert.equal(u.contextStartLine, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review-prep: --changed-only filters to changed lines vs baseline', () => {
  const root = setup();
  try {
    writeFileSync(
      join(root, 'a.css'),
      '.pre { color: var(--color-primary); }\n',
    );
    commit(root);
    // Append a new usage on a new line.
    appendFileSync(join(root, 'a.css'), '.fresh { color: var(--color-danger); }\n');
    const r = runCli(['review-prep', '--changed-only', '--baseline', 'HEAD'], root);
    const data = parseJson(r.stdout);
    // Only the freshly-added usage should appear; pre-existing is filtered.
    assert.equal(data.usagesFound, 1, JSON.stringify(data.usages));
    assert.equal(data.usages[0].tokenName, 'color.danger');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('review-prep: empty catalog refuses with non-zero exit', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-review-empty-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'package.json'), '{"name":"empty"}');
    writeFileSync(join(root, 'tokens.json'), '{}');
    writeFileSync(join(root, 'a.css'), '.x { color: red; }\n');
    const r = runCli(['review-prep', '--full-repo'], root);
    assert.equal(r.status, 2, `expected exit code 2 on empty catalog, got: ${r.status}`);
    assert.match(r.stderr, /No catalog/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
