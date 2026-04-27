import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isExemptFile, scan, classifySurface } from '../lib/scanner.mjs';

test('classifySurface', () => {
  assert.equal(classifySurface('/x/style.css'), 'css');
  assert.equal(classifySurface('/x/Button.tsx'), 'tsx');
  assert.equal(classifySurface('/x/App.vue'), 'vue');
  assert.equal(classifySurface('/x/page.svelte'), 'svelte');
  assert.equal(classifySurface('/x/index.html'), 'html');
  assert.equal(classifySurface('/x/page.astro'), 'astro');
  assert.equal(classifySurface('/x/util.ts'), 'ts');
  assert.equal(classifySurface('/x/random.txt'), null);
});

test('isExemptFile: token sources', () => {
  assert.ok(isExemptFile('/x/tokens.json'));
  assert.ok(isExemptFile('/x/design-tokens.json'));
  assert.ok(isExemptFile('/x/tokens.proposed.json'));
  assert.ok(isExemptFile('/x/tokens.css'));
  assert.ok(isExemptFile('/x/.tokenize/catalog.json'));
  assert.ok(!isExemptFile('/x/Button.tsx'));
});

test('scan: hex color in CSS', () => {
  const v = scan('.x { color: #2563eb; }', '/x/style.css');
  assert.equal(v.length, 1);
  assert.equal(v[0].literal, '#2563eb');
  assert.equal(v[0].type, 'color');
  assert.equal(v[0].surface, 'css');
});

test('scan: rgb() in CSS', () => {
  const v = scan('.x { background: rgb(37,99,235); }', '/x/style.css');
  assert.equal(v.length, 1);
  assert.equal(v[0].type, 'color');
});

test('scan: skips :root token-definition lines', () => {
  const v = scan(':root { --color-primary: #2563eb; }\n.x { color: #ff0000; }', '/x/style.css');
  assert.equal(v.length, 1);
  assert.equal(v[0].literal, '#ff0000');
});

test('scan: dimension in CSS', () => {
  const v = scan('.x { padding: 16px; }', '/x/style.css');
  assert.ok(v.some((x) => x.literal === '16px' && x.type === 'dimension'));
});

test('scan: hex in TSX inline style', () => {
  const v = scan('<div style={{ color: "#2563eb" }} />', '/x/Button.tsx');
  assert.ok(v.some((x) => x.literal === '#2563eb'));
});

test('scan: bare px in TS only inside CSS-in-JS templates', () => {
  const noTemplate = scan('const x = 16; const y = 14;', '/x/util.ts');
  assert.equal(noTemplate.length, 0);
  const withTemplate = scan('const Btn = styled.button`padding: 16px; color: red;`', '/x/Btn.ts');
  assert.ok(withTemplate.some((x) => x.literal === '16px'));
});

test('scan: tailwind arbitrary brackets only when detected', () => {
  const off = scan('<div className="bg-[#2563eb] p-[17px]" />', '/x/A.tsx', { tailwindDetected: false });
  // Tailwind brackets off: hex still flagged via HEX_RE and 17px via DIMENSION_RE.
  assert.ok(off.some((x) => x.literal === '#2563eb'));
  const on = scan('<div className="bg-[#2563eb] p-[17px]" />', '/x/A.tsx', { tailwindDetected: true });
  // Surface is now `tailwind-arbitrary` and type is the inferred color/dimension
  // (per the post-audit fix #7).
  assert.ok(on.some((x) => x.surface === 'tailwind-arbitrary' && x.literal.startsWith('bg-[') && x.type === 'color'),
    `expected tailwind-arbitrary color violation, got: ${JSON.stringify(on)}`);
  assert.ok(on.some((x) => x.surface === 'tailwind-arbitrary' && x.literal.startsWith('p-[') && x.type === 'dimension'),
    `expected tailwind-arbitrary dimension violation, got: ${JSON.stringify(on)}`);
});

test('scan: mixed token-def-and-violation line surfaces both correctly', () => {
  // The token def span gets blanked; the consumer color is still flagged.
  const v = scan(':root { --x: #fff; } .y { color: #abcdef; }', '/x/style.css');
  assert.ok(v.some((x) => x.literal === '#abcdef'),
    `expected to find #abcdef, got: ${JSON.stringify(v)}`);
  assert.ok(!v.some((x) => x.literal === '#fff'),
    `should NOT flag the token-def value #fff, got: ${JSON.stringify(v)}`);
});

test('scan: SVG sentinels (context-fill, etc.) are exempt', () => {
  const a = scan('<svg><circle fill="context-fill" /></svg>', '/x/icon.svg');
  assert.equal(a.length, 0);
  const b = scan('<svg><circle fill="context-stroke" /></svg>', '/x/icon.svg');
  assert.equal(b.length, 0);
  const c = scan('<svg><circle fill="var(--color-primary)" /></svg>', '/x/icon.svg');
  assert.equal(c.length, 0);
});

test('scan: SVG fill attr literal', () => {
  const v = scan('<svg><circle fill="#ff0000" /></svg>', '/x/icon.svg');
  assert.ok(v.some((x) => x.surface === 'svg-attr' && x.literal === '#ff0000'));
});

test('scan: SVG fill currentColor exempt', () => {
  const v = scan('<svg><circle fill="currentColor" /></svg>', '/x/icon.svg');
  assert.equal(v.length, 0);
});

test('scan: exempt files return empty', () => {
  const v = scan(':root { --color-primary: #2563eb; }', '/x/tokens.css');
  assert.equal(v.length, 0);
});
