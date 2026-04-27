import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { canonicalDimension, dimensionDistance, parseDimension } from '../lib/dimension.mjs';

test('parseDimension: px', () => {
  const d = parseDimension('16px');
  assert.deepEqual(d, { value: 16, unit: 'px', px: 16 });
});

test('parseDimension: rem', () => {
  const d = parseDimension('1rem');
  assert.equal(d.px, 16);
});

test('parseDimension: floats', () => {
  const d = parseDimension('1.5rem');
  assert.equal(d.px, 24);
});

test('parseDimension: rejects unknown units', () => {
  assert.equal(parseDimension('16foo'), null);
});

test('parseDimension: rejects garbage', () => {
  assert.equal(parseDimension('not a dim'), null);
});

test('canonicalDimension: trims trailing zeros', () => {
  assert.equal(canonicalDimension('1.50rem'), '1.5rem');
  assert.equal(canonicalDimension('16.0px'), '16px');
});

test('dimensionDistance: same value', () => {
  const a = parseDimension('16px');
  assert.equal(dimensionDistance(a, a), 0);
});

test('dimensionDistance: cross-unit comparison via px', () => {
  const a = parseDimension('1rem');
  const b = parseDimension('16px');
  assert.equal(dimensionDistance(a, b), 0);
});

test('dimensionDistance: handles null', () => {
  assert.equal(dimensionDistance(null, parseDimension('16px')), Infinity);
});
