import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent, compactLedger, consecutiveDeniesFor, readSession } from '../lib/ledger.mjs';

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

test('ledger: consecutiveDeniesFor returns 0 when no denies', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-led2-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"led-test"}');
    const file = join(root, 'sample.tsx');
    assert.equal(consecutiveDeniesFor(file, file, 's1'), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ledger: consecutiveDeniesFor counts trailing deny events ignoring blocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-led-cd-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"led-test"}');
    const file = join(root, 'sample.tsx');
    appendEvent(file, { kind: 'block', sessionId: 's1', file, literal: '#fff' });
    appendEvent(file, { kind: 'deny', sessionId: 's1', file, reason: 'no-match' });
    appendEvent(file, { kind: 'block', sessionId: 's1', file, literal: '#000' });
    appendEvent(file, { kind: 'deny', sessionId: 's1', file, reason: 'no-match' });
    assert.equal(consecutiveDeniesFor(file, file, 's1'), 2);
    appendEvent(file, { kind: 'resolve', sessionId: 's1', file });
    assert.equal(consecutiveDeniesFor(file, file, 's1'), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ledger: consecutiveDeniesFor isolates by session', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-led-iso-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"led-test"}');
    const file = join(root, 'sample.tsx');
    appendEvent(file, { kind: 'deny', sessionId: 's-old', file, reason: 'x' });
    appendEvent(file, { kind: 'deny', sessionId: 's-old', file, reason: 'x' });
    appendEvent(file, { kind: 'deny', sessionId: 's-old', file, reason: 'x' });
    assert.equal(consecutiveDeniesFor(file, file, 's-new'), 0);
    assert.equal(consecutiveDeniesFor(file, file, 's-old'), 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ledger: resolve event clears unresolved count', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-led3-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"led-test"}');
    const file = join(root, 'sample.tsx');
    appendEvent(file, { kind: 'deny', sessionId: 's1', file, reason: 'no-match' });
    appendEvent(file, { kind: 'deny', sessionId: 's1', file, reason: 'no-match' });
    const mid = compactLedger(file, 's1');
    assert.equal(mid.unresolvedByFile[file], 2);
    appendEvent(file, { kind: 'resolve', sessionId: 's1', file });
    const after = compactLedger(file, 's1');
    assert.equal(after.unresolvedByFile[file], 0);
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
