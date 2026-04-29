// End-to-end hook tests: spawn the actual hook scripts, feed JSON to stdin, parse JSON from stdout.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const SESSION_START = join(PLUGIN_ROOT, 'hooks', 'session-start.mjs');
const PRE_TOOL_USE = join(PLUGIN_ROOT, 'hooks', 'pre-tool-use.mjs');

function setupProject() {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-hook-'));
  // Mark as a node project so findRepoRoot stops here.
  writeFileSync(join(root, 'package.json'), '{"name":"sample"}');
  writeFileSync(join(root, 'tokens.json'), JSON.stringify({
    color: {
      primary: { $value: '#2563eb', $type: 'color' },
      danger:  { $value: '#b91c1c', $type: 'color' },
    },
    space: {
      4: { $value: '16px', $type: 'dimension' },
    },
  }));
  return root;
}

function runHook(script, event, cwd) {
  const r = spawnSync('node', [script], {
    input: JSON.stringify(event),
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    encoding: 'utf8',
    timeout: 10000,
  });
  return r;
}

test('SessionStart: emits catalog injection containing token names', () => {
  const root = setupProject();
  try {
    const r = runHook(SESSION_START, { session_id: 'test', cwd: root }, root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput?.additionalContext || '';
    assert.ok(ctx.includes('color.primary'));
    assert.ok(ctx.includes('space.4'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreToolUse: rewrites confidence-1.0 hex match in CSS', () => {
  const root = setupProject();
  try {
    runHook(SESSION_START, { session_id: 's1', cwd: root }, root);
    const event = {
      session_id: 's1',
      tool_name: 'Write',
      tool_input: {
        file_path: join(root, 'src', 'a.css'),
        content: '.btn { color: #2563eb; }',
      },
    };
    const r = runHook(PRE_TOOL_USE, event, root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'allow');
    assert.ok(out.hookSpecificOutput?.updatedInput?.content.includes('var(--color-primary)'));
    assert.ok(!out.hookSpecificOutput?.updatedInput?.content.includes('#2563eb'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreToolUse: rewrites confidence-1.0 dimension in TSX inline style', () => {
  const root = setupProject();
  try {
    runHook(SESSION_START, { session_id: 's1', cwd: root }, root);
    const event = {
      session_id: 's1',
      tool_name: 'Write',
      tool_input: {
        file_path: join(root, 'src', 'B.tsx'),
        content: '<div style={{ padding: 16 }}>x</div>',
      },
    };
    const r = runHook(PRE_TOOL_USE, event, root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    // 16 (no px) won't match the px regex, but `padding: 16px` would. Try with px:
    void out;
    const event2 = { ...event, tool_input: { ...event.tool_input, content: '<div style={{ padding: "16px" }} />' } };
    const r2 = runHook(PRE_TOOL_USE, event2, root);
    const out2 = JSON.parse(r2.stdout);
    assert.equal(out2.hookSpecificOutput?.permissionDecision, 'allow');
    assert.ok(out2.hookSpecificOutput?.updatedInput?.content.includes('tokens.space[4]'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreToolUse: denies low-confidence near-miss with structured suggestion', () => {
  const root = setupProject();
  try {
    runHook(SESSION_START, { session_id: 's1', cwd: root }, root);
    const event = {
      session_id: 's1',
      tool_name: 'Write',
      tool_input: {
        file_path: join(root, 'src', 'c.css'),
        content: '.btn { color: #2462ea; }',  // close to color.primary but not exact
      },
    };
    const r = runHook(PRE_TOOL_USE, event, root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(out.hookSpecificOutput?.permissionDecisionReason.includes('color.primary'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreToolUse: denies edits to tokens.json in consumer mode', () => {
  const root = setupProject();
  try {
    runHook(SESSION_START, { session_id: 's1', cwd: root }, root);
    const event = {
      session_id: 's1',
      tool_name: 'Write',
      tool_input: {
        file_path: join(root, 'tokens.json'),
        content: '{"color":{"new":{"$value":"#0f0","$type":"color"}}}',
      },
    };
    const r = runHook(PRE_TOOL_USE, event, root);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(out.hookSpecificOutput?.permissionDecisionReason.includes('tokenize__propose'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreToolUse: passthrough when no violations', () => {
  const root = setupProject();
  try {
    runHook(SESSION_START, { session_id: 's1', cwd: root }, root);
    const event = {
      session_id: 's1',
      tool_name: 'Write',
      tool_input: {
        file_path: join(root, 'src', 'd.css'),
        content: '.btn { color: var(--color-primary); }',
      },
    };
    const r = runHook(PRE_TOOL_USE, event, root);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'allow');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreToolUse: hard-stops after 3 consecutive denied tool calls', () => {
  const root = setupProject();
  try {
    runHook(SESSION_START, { session_id: 's1', cwd: root }, root);
    const file = join(root, 'src', 'e.css');
    // Three consecutive deny-causing edits to same file in same session.
    for (let i = 0; i < 3; i++) {
      runHook(PRE_TOOL_USE, {
        session_id: 's1',
        tool_name: 'Write',
        tool_input: { file_path: file, content: `.x { color: #ff${i}000; }` },
      }, root);
    }
    // 4th attempt → hard-stop.
    const r = runHook(PRE_TOOL_USE, {
      session_id: 's1',
      tool_name: 'Write',
      tool_input: { file_path: file, content: `.x { color: #ff0000; }` },
    }, root);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(
      out.hookSpecificOutput?.permissionDecisionReason.includes('HARD-STOP'),
      `expected HARD-STOP, got: ${out.hookSpecificOutput?.permissionDecisionReason}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreToolUse: budget is per-session — old session denies do not affect new session', () => {
  const root = setupProject();
  try {
    runHook(SESSION_START, { session_id: 's-old', cwd: root }, root);
    const file = join(root, 'src', 'session-iso.css');
    // 3 denies in old session → would normally hard-stop on 4th in old session.
    for (let i = 0; i < 3; i++) {
      runHook(PRE_TOOL_USE, {
        session_id: 's-old',
        tool_name: 'Write',
        tool_input: { file_path: file, content: `.x { color: #ff${i}aaa; }` },
      }, root);
    }
    // New session starts — budget should be fresh.
    runHook(SESSION_START, { session_id: 's-new', cwd: root }, root);
    const r = runHook(PRE_TOOL_USE, {
      session_id: 's-new',
      tool_name: 'Write',
      tool_input: { file_path: file, content: `.x { color: #ff0000; }` },
    }, root);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(
      !out.hookSpecificOutput?.permissionDecisionReason.includes('HARD-STOP'),
      'new session should not see old session\'s budget',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: when stdin is not valid JSON, the hook must fail CLOSED (deny) rather
// than passthrough-allow. A corrupted or attacker-influenced event is exactly the
// case where a security gate must refuse to make a decision. Defends finding #4.
test('PreToolUse: malformed event JSON denies (fails closed)', () => {
  const root = setupProject();
  try {
    const r = spawnSync('node', [PRE_TOOL_USE], {
      input: 'this is not json',
      cwd: root,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(r.status, 0, `hook should exit 0 with structured deny, got: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(
      out.hookSpecificOutput?.permissionDecisionReason.includes('malformed'),
      `expected malformed-event reason, got: ${out.hookSpecificOutput?.permissionDecisionReason}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreToolUse: MultiEdit applies all edit rewrites correctly', () => {
  const root = setupProject();
  try {
    runHook(SESSION_START, { session_id: 's1', cwd: root }, root);
    const event = {
      session_id: 's1',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: join(root, 'src', 'multi.css'),
        edits: [
          { old_string: 'A', new_string: '.a { color: #2563eb; }' },
          { old_string: 'B', new_string: '.b { color: #b91c1c; }' },
        ],
      },
    };
    const r = runHook(PRE_TOOL_USE, event, root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'allow');
    const updatedEdits = out.hookSpecificOutput?.updatedInput?.edits;
    assert.ok(updatedEdits, 'updatedInput.edits should exist');
    assert.equal(updatedEdits.length, 2);
    assert.ok(updatedEdits[0].new_string.includes('var(--color-primary)'),
      `first edit not rewritten: ${updatedEdits[0].new_string}`);
    assert.ok(updatedEdits[1].new_string.includes('var(--color-danger)'),
      `second edit not rewritten: ${updatedEdits[1].new_string}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── css-vars sources in maintainer mode allow direct edit ──────────────
// Regression: prior behavior denied ALL token-source edits in maintainer
// mode, leaving css-vars-based projects with no working unlock path
// (add_token writes only to tokens.json, not css-vars). Now: dtcg-json
// sources keep the deny; css-vars sources passthrough.

function setupCssVarsProject({ maintainer = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-cssvars-'));
  writeFileSync(join(root, 'package.json'), '{"name":"cssvars-test"}');
  // src/styles/theme.css with a single :root token — discovery picks this up
  // as a css-vars source.
  const cssDir = join(root, 'src', 'styles');
  mkdirSync(cssDir, { recursive: true });
  writeFileSync(join(cssDir, 'theme.css'), ':root {\n  --color-primary: #2563eb;\n}\n');
  if (maintainer) {
    mkdirSync(join(root, '.tokenize'), { recursive: true });
    writeFileSync(join(root, '.tokenize', 'config.json'), JSON.stringify({ mode: 'maintainer' }));
  }
  return root;
}

test('PreToolUse: css-vars source allows direct Write in maintainer mode', () => {
  const root = setupCssVarsProject();
  try {
    runHook(SESSION_START, { session_id: 's1', cwd: root }, root);
    const event = {
      session_id: 's1',
      tool_name: 'Write',
      tool_input: {
        file_path: join(root, 'src', 'styles', 'theme.css'),
        content: ':root {\n  --color-primary: #2563eb;\n  --color-accent: #f97316;\n}\n',
      },
    };
    const r = runHook(PRE_TOOL_USE, event, root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'allow',
      `expected allow for css-vars in maintainer mode, got: ${out.hookSpecificOutput?.permissionDecisionReason}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreToolUse: css-vars source denies direct Write in consumer mode', () => {
  const root = setupCssVarsProject({ maintainer: false });
  try {
    runHook(SESSION_START, { session_id: 's1', cwd: root }, root);
    const event = {
      session_id: 's1',
      tool_name: 'Write',
      tool_input: {
        file_path: join(root, 'src', 'styles', 'theme.css'),
        content: ':root { --color-primary: red; }',
      },
    };
    const r = runHook(PRE_TOOL_USE, event, root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(
      out.hookSpecificOutput?.permissionDecisionReason.includes('not allowed in consumer mode'),
      `expected consumer-mode deny, got: ${out.hookSpecificOutput?.permissionDecisionReason}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PreToolUse: tokens.json source still denies direct Write in maintainer mode', () => {
  // DTCG sources keep the deny-direct-edit policy — that's where schema
  // enforcement actually matters.
  const root = setupProject();
  try {
    mkdirSync(join(root, '.tokenize'), { recursive: true });
    writeFileSync(join(root, '.tokenize', 'config.json'), JSON.stringify({ mode: 'maintainer' }));
    runHook(SESSION_START, { session_id: 's1', cwd: root }, root);
    const event = {
      session_id: 's1',
      tool_name: 'Write',
      tool_input: {
        file_path: join(root, 'tokens.json'),
        content: '{"color":{"primary":{"$value":"#000","$type":"color"}}}',
      },
    };
    const r = runHook(PRE_TOOL_USE, event, root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(
      out.hookSpecificOutput?.permissionDecisionReason.includes('add_token'),
      `expected DTCG-direct-edit deny pointing at add_token, got: ${out.hookSpecificOutput?.permissionDecisionReason}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
