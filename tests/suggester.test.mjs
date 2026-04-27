import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { suggest } from '../lib/suggester.mjs';

const CATALOG = {
  generatedAt: 'now',
  root: '/x',
  sources: [],
  conflicts: [],
  tokens: {
    'color.primary': { name: 'color.primary', value: '#2563eb', type: 'color', tier: 'semantic', originPath: '/x/t.json', originType: 'dtcg-json' },
    'color.danger':  { name: 'color.danger',  value: '#b91c1c', type: 'color', tier: 'semantic', originPath: '/x/t.json', originType: 'dtcg-json' },
    'space.4':       { name: 'space.4',       value: '16px',    type: 'dimension', tier: 'semantic', originPath: '/x/t.json', originType: 'dtcg-json' },
    'space.6':       { name: 'space.6',       value: '24px',    type: 'dimension', tier: 'semantic', originPath: '/x/t.json', originType: 'dtcg-json' },
    'primitive.red.500': { name: 'primitive.red.500', value: '#ef4444', type: 'color', tier: 'primitive', originPath: '/x/t.json', originType: 'dtcg-json' },
  },
  valueIndex: {
    color: [
      { value: '#2563eb', normalized: { r: 0x25, g: 0x63, b: 0xeb, a: 1 }, tokenNames: ['color.primary'] },
      { value: '#b91c1c', normalized: { r: 0xb9, g: 0x1c, b: 0x1c, a: 1 }, tokenNames: ['color.danger'] },
    ],
    dimension: [
      { value: '16px', normalized: { value: 16, unit: 'px', px: 16 }, tokenNames: ['space.4'] },
      { value: '24px', normalized: { value: 24, unit: 'px', px: 24 }, tokenNames: ['space.6'] },
    ],
  },
};

function makeViolation(literal, type) {
  return { literal, type, surface: 'css', line: 1, column: 1 };
}

test('suggest: exact color match returns confidence 1.0', () => {
  const r = suggest(makeViolation('#2563eb', 'color'), CATALOG);
  assert.equal(r.primary.tokenName, 'color.primary');
  assert.equal(r.primary.confidence, 1.0);
});

test('suggest: near color returns nearest with reduced confidence', () => {
  const r = suggest(makeViolation('#2462ea', 'color'), CATALOG);
  assert.equal(r.primary.tokenName, 'color.primary');
  assert.ok(r.primary.confidence < 1.0);
  assert.ok(r.primary.confidence >= 0.5);
});

test('suggest: very far color returns null', () => {
  const r = suggest(makeViolation('#00ff00', 'color'), CATALOG);
  assert.equal(r.primary, null);
});

test('suggest: exact dimension', () => {
  const r = suggest(makeViolation('16px', 'dimension'), CATALOG);
  assert.equal(r.primary.tokenName, 'space.4');
  assert.equal(r.primary.confidence, 1.0);
});

test('suggest: dimension cross-unit (1rem matches 16px)', () => {
  const r = suggest(makeViolation('1rem', 'dimension'), CATALOG);
  assert.equal(r.primary.tokenName, 'space.4');
  assert.equal(r.primary.confidence, 1.0);
});

test('suggest: dimension out of tolerance', () => {
  const r = suggest(makeViolation('100px', 'dimension'), CATALOG);
  assert.equal(r.primary, null);
});
