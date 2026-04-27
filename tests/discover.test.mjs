import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseDtcg } from '../lib/discover/dtcg.mjs';
import { parseCssVars } from '../lib/discover/css-vars.mjs';

test('parseDtcg: nested groups + types', () => {
  const doc = {
    color: {
      text: {
        primary: { $value: '#0a0a0a', $type: 'color' },
        danger:  { $value: '#b91c1c', $type: 'color', $description: 'errors' },
      },
    },
    space: {
      4: { $value: '16px', $type: 'dimension' },
    },
  };
  const tokens = parseDtcg(doc, '/x/tokens.json');
  const names = tokens.map((t) => t.name).sort();
  assert.deepEqual(names, ['color.text.danger', 'color.text.primary', 'space.4']);
  const danger = tokens.find((t) => t.name === 'color.text.danger');
  assert.equal(danger.value, '#b91c1c');
  assert.equal(danger.type, 'color');
  assert.equal(danger.description, 'errors');
});

test('parseDtcg: aliases resolve in same doc', () => {
  const doc = {
    color: {
      primitive: {
        red: { 700: { $value: '#b91c1c', $type: 'color' } },
      },
      text: {
        danger: { $value: '{color.primitive.red.700}', $type: 'color' },
      },
    },
  };
  const tokens = parseDtcg(doc, '/x/tokens.json');
  const danger = tokens.find((t) => t.name === 'color.text.danger');
  assert.equal(danger.value, '#b91c1c');
});

test('parseDtcg: tier inference', () => {
  const doc = {
    primitive: {
      red: { $value: '#f00', $type: 'color' },
    },
    color: {
      text: {
        danger: { $value: '#b91c1c', $type: 'color' },
      },
    },
  };
  const tokens = parseDtcg(doc, '/x/tokens.json');
  const prim = tokens.find((t) => t.name === 'primitive.red');
  const sem = tokens.find((t) => t.name === 'color.text.danger');
  assert.equal(prim.tier, 'primitive');
  assert.equal(sem.tier, 'component');     // 3 segments → component
});

test('parseCssVars: extracts :root variables', () => {
  const css = `
    :root {
      --color-primary: #2563eb;
      --space-4: 16px;
      --some-text: 14px;
    }
    .foo { color: red; }
  `;
  const tokens = parseCssVars(css, '/x/styles.css');
  const names = tokens.map((t) => t.name).sort();
  assert.deepEqual(names, ['color.primary', 'some.text', 'space.4']);
  assert.equal(tokens.find((t) => t.name === 'color.primary').type, 'color');
  assert.equal(tokens.find((t) => t.name === 'space.4').type, 'dimension');
});

test('parseCssVars: ignores non-:root selectors', () => {
  const css = `.button { --x: 10px; }`;
  const tokens = parseCssVars(css, '/x/styles.css');
  assert.equal(tokens.length, 0);
});
