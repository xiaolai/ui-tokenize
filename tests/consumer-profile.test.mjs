// Tests for consumer-API discovery — observing how the project actually references tokens.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverConsumerProfile } from '../lib/consumer-profile.mjs';

function setupSampleProject() {
  const root = mkdtempSync(join(tmpdir(), 'ui-tokenize-cp-'));
  writeFileSync(join(root, 'package.json'), '{"name":"sample"}');
  return root;
}

test('consumer-profile: detects var(--*) convention in CSS', () => {
  const root = setupSampleProject();
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.css'), `
      .x { color: var(--color-primary); padding: var(--space-4); }
      .y { background: var(--color-bg); }
    `);
    const profile = discoverConsumerProfile(root);
    assert.equal(profile.surfaces.css.convention, 'var(--{kebab})');
    assert.ok(profile.surfaces.css.confidence === 'high' || profile.surfaces.css.confidence === 'medium');
    assert.ok(profile.surfaces.css.samples >= 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumer-profile: detects tokens.X convention in TSX', () => {
  const root = setupSampleProject();
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'Btn.tsx'), `
      const Btn = () => <div style={{ color: tokens.color.primary, padding: tokens.space[4] }}>hi</div>
      const Btn2 = () => <div style={{ color: tokens.color.danger }}>err</div>
    `);
    const profile = discoverConsumerProfile(root);
    assert.equal(profile.surfaces.tsx.convention, 'tokens.{js}');
    assert.ok(profile.surfaces.tsx.samples >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumer-profile: detects theme.X convention when dominant', () => {
  const root = setupSampleProject();
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'A.tsx'), `
      const A = () => <div style={{ color: theme.color.primary, padding: theme.space[4] }}/>
      const B = () => <div style={{ color: theme.color.danger }}/>
      const C = () => <div style={{ color: theme.color.text }}/>
    `);
    const profile = discoverConsumerProfile(root);
    assert.equal(profile.surfaces.tsx.convention, 'theme.{js}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumer-profile: returns confidence none when no patterns observed', () => {
  const root = setupSampleProject();
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.css'), `.x { color: red; }`);
    const profile = discoverConsumerProfile(root);
    assert.equal(profile.surfaces.css.confidence, 'none');
    assert.equal(profile.surfaces.css.samples, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumer-profile: respects .gitignore', () => {
  const root = setupSampleProject();
  try {
    writeFileSync(join(root, '.gitignore'), 'src/\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.css'), `.x { color: var(--x); }`);
    const profile = discoverConsumerProfile(root);
    // src/ ignored → no samples found
    assert.ok(!profile.surfaces.css || profile.surfaces.css.confidence === 'none');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
