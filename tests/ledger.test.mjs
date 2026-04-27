import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent, compactLedger, readSession, unresolvedBlocksFor } from '../lib/ledger.mjs';

test('ledger: append + compact aggregates events', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-led-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"led-test"}');
    const file = join(root, 'sample.tsx');
    appendEvent(file, { kind: 'block', sessionId: 's1', file, line: 10, literal: '#fff' });
    appendEvent(file, { kind: 'rewrite', sessionId: 's1', file, line: 11, literal: '16', token: 'space.4' });
    const state = compactLedger(file, 's1');
    assert.equal(state.metrics.blocks, 1);
    assert.equal(state.metrics.rewrites, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ledger: unresolvedBlocksFor returns 0 when no blocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-led2-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"led-test"}');
    const file = join(root, 'sample.tsx');
    compactLedger(file, 's1');
    assert.equal(unresolvedBlocksFor(file, file), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ledger: rewrite reduces unresolved count', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-led3-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"led-test"}');
    const file = join(root, 'sample.tsx');
    appendEvent(file, { kind: 'block', sessionId: 's1', file, line: 10, literal: '#fff' });
    appendEvent(file, { kind: 'block', sessionId: 's1', file, line: 11, literal: '16' });
    appendEvent(file, { kind: 'rewrite', sessionId: 's1', file, line: 11, literal: '16', token: 'space.4' });
    const state = compactLedger(file, 's1');
    // 2 blocks - 1 rewrite = 1 unresolved.
    assert.equal(state.unresolvedByFile[file], 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ledger: read returns null when no session', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-led4-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"led-test"}');
    const file = join(root, 'sample.tsx');
    assert.equal(readSession(file), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
