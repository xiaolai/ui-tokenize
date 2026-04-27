import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { canonicalColor, deltaE, parseColor } from '../lib/color.mjs';

test('parseColor: hex 6-digit', () => {
  const c = parseColor('#2563eb');
  assert.deepEqual(c, { r: 0x25, g: 0x63, b: 0xeb, a: 1 });
});

test('parseColor: hex 3-digit', () => {
  const c = parseColor('#fff');
  assert.deepEqual(c, { r: 255, g: 255, b: 255, a: 1 });
});

test('parseColor: hex 8-digit alpha', () => {
  const c = parseColor('#2563eb80');
  assert.equal(c.r, 0x25);
  assert.ok(Math.abs(c.a - 0.502) < 0.01);
});

test('parseColor: rgb()', () => {
  const c = parseColor('rgb(37, 99, 235)');
  assert.deepEqual(c, { r: 37, g: 99, b: 235, a: 1 });
});

test('parseColor: rgba() with alpha', () => {
  const c = parseColor('rgba(37, 99, 235, 0.5)');
  assert.equal(c.a, 0.5);
});

test('parseColor: hsl()', () => {
  const c = parseColor('hsl(220, 83%, 53%)');
  assert.ok(c);
  assert.ok(Math.abs(c.r - 36) < 5);
  assert.ok(Math.abs(c.g - 99) < 5);
  assert.ok(Math.abs(c.b - 235) < 5);
});

test('parseColor: rejects garbage', () => {
  assert.equal(parseColor('not a color'), null);
  assert.equal(parseColor('#xyz'), null);
});

test('canonicalColor: normalizes hex case', () => {
  assert.equal(canonicalColor('#FFFFFF'), '#ffffff');
  assert.equal(canonicalColor('#FFF'), '#ffffff');
  assert.equal(canonicalColor('rgb(255,255,255)'), '#ffffff');
});

test('deltaE: identical = 0', () => {
  const a = parseColor('#2563eb');
  assert.equal(deltaE(a, a), 0);
});

test('deltaE: similar colors are small', () => {
  const a = parseColor('#2563eb');
  const b = parseColor('#2462ea');
  const d = deltaE(a, b);
  assert.ok(d < 2.0, `expected ΔE < 2.0, got ${d}`);
});

test('deltaE: very different colors are large', () => {
  const a = parseColor('#000000');
  const b = parseColor('#ffffff');
  const d = deltaE(a, b);
  assert.ok(d > 50, `expected ΔE > 50, got ${d}`);
});
