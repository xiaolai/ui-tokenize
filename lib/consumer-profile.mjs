// Consumer-API discovery (R-05): observe how the project actually references tokens.
// Run at session start; build a profile per surface; renderer dispatches on it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const SAMPLE_LIMIT_PER_SURFACE = 10;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '.tokenize']);

const SURFACE_PATTERNS = {
  css: [
    { pattern: /var\(\s*(--[a-z][a-z0-9-]*)\s*\)/gi, convention: 'var(--{kebab})' },
  ],
  scss: [
    { pattern: /\$([a-z][a-z0-9-]*)\b/gi, convention: '${kebab}' },
    { pattern: /var\(\s*(--[a-z][a-z0-9-]*)\s*\)/gi, convention: 'var(--{kebab})' },
  ],
  less: [
    { pattern: /@([a-z][a-z0-9-]*)\b/gi, convention: '@{kebab}' },
    { pattern: /var\(\s*(--[a-z][a-z0-9-]*)\s*\)/gi, convention: 'var(--{kebab})' },
  ],
  tsx: [
    { pattern: /tokens\.([a-z][a-zA-Z0-9.[\]]*)/g, convention: 'tokens.{js}' },
    { pattern: /theme\.([a-z][a-zA-Z0-9.[\]]*)/g, convention: 'theme.{js}' },
    { pattern: /vars\.([a-z][a-zA-Z0-9.[\]]*)/g, convention: 'vars.{js}' },
  ],
  ts: [
    { pattern: /tokens\.([a-z][a-zA-Z0-9.[\]]*)/g, convention: 'tokens.{js}' },
    { pattern: /theme\.([a-z][a-zA-Z0-9.[\]]*)/g, convention: 'theme.{js}' },
  ],
  vue: [
    { pattern: /var\(\s*(--[a-z][a-z0-9-]*)\s*\)/gi, convention: 'var(--{kebab})' },
  ],
  svelte: [
    { pattern: /var\(\s*(--[a-z][a-z0-9-]*)\s*\)/gi, convention: 'var(--{kebab})' },
  ],
  astro: [
    { pattern: /var\(\s*(--[a-z][a-z0-9-]*)\s*\)/gi, convention: 'var(--{kebab})' },
  ],
};

const SURFACE_EXTS = {
  '.css': 'css',
  '.pcss': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.tsx': 'tsx',
  '.jsx': 'tsx',
  '.ts': 'ts',
  '.js': 'ts',
  '.mjs': 'ts',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
};

/**
 * @typedef {object} SurfaceProfile
 * @property {string} convention
 * @property {"high"|"medium"|"low"|"none"} confidence
 * @property {number} samples           - how many usages observed
 * @property {Object<string, number>} [conventionCounts]  - if multiple seen
 *
 * @typedef {object} ConsumerProfile
 * @property {string} root
 * @property {Object<string, SurfaceProfile>} surfaces
 */

/**
 * Walk the project, sample a few files per surface, observe token-reference patterns.
 *
 * @param {string} root - absolute path of project root
 * @returns {ConsumerProfile}
 */
export function discoverConsumerProfile(root) {
  /** @type {Record<string, string[]>} */
  const filesBySurface = {};
  collectFiles(root, root, filesBySurface);

  /** @type {ConsumerProfile['surfaces']} */
  const surfaces = {};
  for (const [surface, files] of Object.entries(filesBySurface)) {
    surfaces[surface] = analyzeSurface(surface, files.slice(0, SAMPLE_LIMIT_PER_SURFACE));
  }
  return { root, surfaces };
}

function collectFiles(dir, root, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (existsSync(join(full, 'package.json')) && full !== root) continue;
      collectFiles(full, root, out);
    } else if (e.isFile()) {
      const surface = SURFACE_EXTS[extname(e.name).toLowerCase()];
      if (!surface) continue;
      if (!out[surface]) out[surface] = [];
      out[surface].push(full);
    }
  }
}

function analyzeSurface(surface, files) {
  const patterns = SURFACE_PATTERNS[surface];
  if (!patterns) return { convention: '', confidence: 'none', samples: 0 };
  /** @type {Object<string, number>} */
  const counts = {};
  let totalSamples = 0;
  for (const file of files) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    for (const { pattern, convention } of patterns) {
      const matches = content.match(pattern) || [];
      if (matches.length > 0) {
        counts[convention] = (counts[convention] || 0) + matches.length;
        totalSamples += matches.length;
      }
    }
  }
  if (totalSamples === 0) {
    return { convention: '', confidence: 'none', samples: 0 };
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topConvention, topCount] = sorted[0];
  const dominance = topCount / totalSamples;
  const confidence = dominance >= 0.85 ? 'high' : dominance >= 0.5 ? 'medium' : 'low';
  return {
    convention: topConvention,
    confidence,
    samples: totalSamples,
    conventionCounts: counts,
  };
}
