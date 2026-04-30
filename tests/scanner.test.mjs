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

// --------------------------------------------------------------------------------
// Comment-stripping false-positive regression tests
// --------------------------------------------------------------------------------

test('scan: ignores hex in JS line comment (regression: issue refs)', () => {
  const v = scan('const x = 1; // fixes issue #2563eb in some module\n', '/x/file.ts');
  assert.equal(v.length, 0, `unexpected violations: ${JSON.stringify(v)}`);
});

test('scan: ignores hex in JS block comment', () => {
  const v = scan('const x = 1; /* see #2563eb for context */ const y = 2;\n', '/x/file.ts');
  assert.equal(v.length, 0);
});

test('scan: ignores hex in multi-line JSDoc', () => {
  const src = [
    '/**',
    ' * Fixes color drift.',
    ' * @see #2563eb',
    ' * @issue #abc',
    ' */',
    'export const X = 1;',
  ].join('\n');
  const v = scan(src, '/x/util.ts');
  assert.equal(v.length, 0);
});

test('scan: short hex shorthand (#298) inside JS line comment is not flagged', () => {
  const v = scan('// see #298 for the original report\n', '/x/handler.ts');
  assert.equal(v.length, 0);
});

test('scan: ignores hex in JSX block comment {/* */}', () => {
  const v = scan('export const X = () => <div>{/* tracked at #2563eb */}<span/></div>;', '/x/View.tsx');
  assert.equal(v.length, 0);
});

test('scan: ignores hex in CSS block comment', () => {
  const v = scan('.foo { /* alias for #2563eb */ color: blue; }\n', '/x/style.css');
  assert.equal(v.length, 0);
});

test('scan: ignores hex in SCSS line comment', () => {
  const v = scan('$primary: blue; // legacy was #2563eb\n', '/x/style.scss');
  assert.equal(v.length, 0);
});

test('scan: ignores hex in HTML comment', () => {
  const v = scan('<!-- old palette: #2563eb --><div></div>', '/x/page.html');
  assert.equal(v.length, 0);
});

test('scan: still flags real hex AFTER a comment on same line', () => {
  const v = scan('.foo { /* see #abc */ color: #2563eb; }\n', '/x/style.css');
  assert.equal(v.length, 1, `expected one violation, got: ${JSON.stringify(v)}`);
  assert.equal(v[0].literal, '#2563eb');
});

test('scan: still flags real hex BEFORE a comment on same line', () => {
  const v = scan('const x = "#2563eb"; // an example value', '/x/util.ts');
  // The hex is inside a string literal — strings remain scannable
  // (we want to catch JSX inline-style strings like style={{color:"#abc"}}).
  assert.ok(v.some((x) => x.literal === '#2563eb'));
});

test('scan: comment-like content INSIDE a string is preserved', () => {
  // The `//` here is part of a string, not a real comment. The hex that
  // *follows* the string on the same line should still be flagged because
  // the string protection consumes only the string, not later code.
  const v = scan('const url = "// not a comment"; const c = "#2563eb";', '/x/util.ts');
  assert.ok(v.some((x) => x.literal === '#2563eb'));
});

test('scan: block-comment-like content inside a single-quoted string is preserved', () => {
  const v = scan(`const s = '/* still a string */'; const c = "#abc";`, '/x/util.ts');
  // The `/* */` inside the string must NOT consume the rest of the line.
  // After string protection, the second string `"#abc"` should still be scanned.
  assert.ok(v.some((x) => x.literal === '#abc'));
});

test('scan: multi-line block comment in TS strips content across line boundaries', () => {
  const src = [
    'const a = 1; /*',
    ' * still inside a comment',
    ' * #2563eb is referenced here',
    ' */ const b = 2;',
  ].join('\n');
  const v = scan(src, '/x/file.ts');
  assert.equal(v.length, 0);
});

test('scan: line numbers stay correct after multi-line block comment is stripped', () => {
  const src = [
    'const a = 1; /*',                // line 1
    ' * #abc multi',                  // line 2 (inside block comment)
    ' */',                             // line 3
    'const c = "#2563eb";',           // line 4 — real violation
  ].join('\n');
  const v = scan(src, '/x/file.ts');
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 4);
});

// --------------------------------------------------------------------------------
// HEX_RE lookbehind tightening (URL fragments, private fields, identifier hashes)
// --------------------------------------------------------------------------------

test('scan: URL fragment in CSS comment is not flagged (was double-protected by both fixes)', () => {
  const v = scan('/* see https://example.com#2563eb */\n.x { color: blue; }', '/x/style.css');
  assert.equal(v.length, 0);
});

test('scan: URL fragment after slash is not flagged', () => {
  // String contents are preserved, but the lookbehind rejects `#abc` preceded
  // by an identifier character. `https://example.com/path#2563eb` has `h`
  // before the `#` (after path char `h`).
  const v = scan('const u = "https://example.com/path#2563eb";', '/x/util.ts');
  assert.equal(v.length, 0, `unexpected violations: ${JSON.stringify(v)}`);
});

test('scan: GitHub permalink-style fragment is not flagged', () => {
  const v = scan('const u = "github.com/foo/pull/298#abc123";', '/x/util.ts');
  assert.equal(v.length, 0);
});

test('scan: URL fragment after dash is not flagged', () => {
  const v = scan('const u = "/path-name#abc123";', '/x/util.ts');
  assert.equal(v.length, 0);
});

test('scan: TS private-field access (this.#xxx) is not flagged', () => {
  const v = scan('class X { #abc = 1; getter() { return this.#abc; } }', '/x/x.ts');
  assert.equal(v.length, 0);
});

test('scan: still flags hex preceded by a CSS-value-marker character (no regression)', () => {
  // Each of these contexts should match HEX_RE under the new lookbehind.
  const cases = [
    { src: '.x { color: #abc; }',        path: '/x/a.css', expect: '#abc' },
    { src: '.x { color:#abc; }',         path: '/x/b.css', expect: '#abc' }, // no space after `:`
    { src: '.x { box-shadow: 0 0 5px #abc; }', path: '/x/c.css', expect: '#abc' },
    { src: '.x { background: linear-gradient(red, #abc, blue); }', path: '/x/d.css', expect: '#abc' },
    { src: 'export const X = () => <div style={{ color: "#abc" }}/>;', path: '/x/e.tsx', expect: '#abc' },
    { src: '<div style="color: #abc"></div>',     path: '/x/f.html', expect: '#abc' },
  ];
  for (const c of cases) {
    const v = scan(c.src, c.path);
    assert.ok(
      v.some((x) => x.literal === c.expect),
      `${c.path}: expected to find ${c.expect}, got ${JSON.stringify(v)}`,
    );
  }
});

test('scan: triple-slash directive does not produce false positives', () => {
  const v = scan('/// <reference types="node" />\nconst c = 1;', '/x/index.ts');
  assert.equal(v.length, 0);
});

test('scan: shebang line in .mjs is not flagged', () => {
  const v = scan('#!/usr/bin/env node\nconst c = 1;', '/x/cli.mjs');
  assert.equal(v.length, 0);
});

test('scan: SCSS file with both block and line comments scrubbed', () => {
  const src = [
    '/* block: #2563eb */',
    '// line: #ff0000',
    '$ok: red;',
    '.x { color: #2563eb; }',
  ].join('\n');
  const v = scan(src, '/x/style.scss');
  assert.equal(v.length, 1, `unexpected violations: ${JSON.stringify(v)}`);
  assert.equal(v[0].literal, '#2563eb');
});

test('scan: HTML file with comment around inline style still flags the inline style', () => {
  const src = [
    '<!-- old: #2563eb -->',
    '<div style="color: #ff0000"></div>',
  ].join('\n');
  const v = scan(src, '/x/page.html');
  // Comment-stripping kills the first hex; HTML inline style still fires.
  assert.ok(v.some((x) => x.literal === '#ff0000'));
  assert.ok(!v.some((x) => x.literal === '#2563eb'));
});
