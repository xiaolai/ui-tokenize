import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverCatalog } from '../lib/catalog.mjs';

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-cat-'));
  return root;
}

test('discoverCatalog: empty project', () => {
  const root = makeProject();
  try {
    const cat = discoverCatalog(root);
    assert.equal(Object.keys(cat.tokens).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverCatalog: DTCG only', () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, 'tokens.json'), JSON.stringify({
      color: { primary: { $value: '#2563eb', $type: 'color' } },
      space: { 4: { $value: '16px', $type: 'dimension' } },
    }));
    const cat = discoverCatalog(root);
    assert.ok(cat.tokens['color.primary']);
    assert.ok(cat.tokens['space.4']);
    assert.equal(cat.tokens['color.primary'].value, '#2563eb');
    assert.ok(cat.valueIndex.color);
    assert.ok(cat.valueIndex.dimension);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverCatalog: CSS-vars only', () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, 'styles'));
    writeFileSync(join(root, 'styles', 'tokens.css'), `:root { --color-primary: #2563eb; --space-4: 16px; }`);
    // tokens.css is exempt to scanner but should still be parsed by discoverer.
    const cat = discoverCatalog(root);
    assert.ok(cat.tokens['color.primary']);
    assert.ok(cat.tokens['space.4']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverCatalog: DTCG wins over CSS-vars on conflict', () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, 'tokens.json'), JSON.stringify({
      color: { primary: { $value: '#2563eb', $type: 'color' } },
    }));
    mkdirSync(join(root, 'styles'));
    writeFileSync(join(root, 'styles', '_root.css'), `:root { --color-primary: #ff0000; }`);
    const cat = discoverCatalog(root);
    assert.equal(cat.tokens['color.primary'].value, '#2563eb');
    assert.equal(cat.conflicts.length, 1);
    assert.equal(cat.conflicts[0].resolution, 'dtcg-json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverCatalog: skips nested package.json directories', () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, 'tokens.json'), JSON.stringify({
      color: { primary: { $value: '#2563eb', $type: 'color' } },
    }));
    mkdirSync(join(root, 'packages', 'pkg-a'), { recursive: true });
    writeFileSync(join(root, 'packages', 'pkg-a', 'package.json'), '{"name":"pkg-a"}');
    writeFileSync(join(root, 'packages', 'pkg-a', 'tokens.json'), JSON.stringify({
      color: { primary: { $value: '#ff0000', $type: 'color' } },
    }));
    const cat = discoverCatalog(root);
    assert.equal(cat.tokens['color.primary'].value, '#2563eb');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverCatalog: primitives excluded from valueIndex', () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, 'tokens.json'), JSON.stringify({
      primitive: {
        red: { 500: { $value: '#ef4444', $type: 'color' } },
      },
      color: { danger: { $value: '#b91c1c', $type: 'color' } },
    }));
    const cat = discoverCatalog(root);
    const colorEntries = cat.valueIndex.color || [];
    assert.ok(colorEntries.find((e) => e.value === '#b91c1c'));
    assert.ok(!colorEntries.find((e) => e.value === '#ef4444'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
