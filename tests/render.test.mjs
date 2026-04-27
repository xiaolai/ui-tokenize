import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderToken, replaceAt } from '../lib/render.mjs';

test('renderToken: CSS surface uses var()', () => {
  assert.equal(renderToken('color.text.danger', 'css'), 'var(--color-text-danger)');
});

test('renderToken: SCSS surface uses $', () => {
  assert.equal(renderToken('color.text.danger', 'scss'), '$color-text-danger');
});

test('renderToken: LESS surface uses @', () => {
  assert.equal(renderToken('color.text.danger', 'less'), '@color-text-danger');
});

test('renderToken: TSX surface uses tokens.path', () => {
  assert.equal(renderToken('color.text.danger', 'tsx'), 'tokens.color.text.danger');
});

test('renderToken: numeric segments get bracket access', () => {
  assert.equal(renderToken('space.4', 'tsx'), 'tokens.space[4]');
});

test('renderToken: respects observed convention', () => {
  const profile = { surfaces: { tsx: { convention: 'theme.{js}', confidence: 'high', samples: 10 } } };
  assert.equal(renderToken('color.primary', 'tsx', profile), 'theme.color.primary');
});

test('renderToken: falls back to default when convention is empty', () => {
  const profile = { surfaces: { tsx: { convention: '', confidence: 'none', samples: 0 } } };
  assert.equal(renderToken('color.primary', 'tsx', profile), 'tokens.color.primary');
});

test('replaceAt: substitutes literal at the right column', () => {
  const out = replaceAt('  color: #2563eb;', { line: 1, column: 10, literal: '#2563eb' }, 'var(--color-primary)');
  assert.equal(out, '  color: var(--color-primary);');
});

test('replaceAt: refuses if content moved', () => {
  const out = replaceAt('  color: red;', { line: 1, column: 10, literal: '#2563eb' }, 'var(--x)');
  assert.equal(out, '  color: red;');
});
