// Extract CSS custom properties from :root / :host / :host-context / .light / .dark blocks.
// Regex-based; good enough for v0.1.

import { parseColor } from '../color.mjs';
import { parseDimension } from '../dimension.mjs';

const ROOT_BLOCK_RE = /(?::root|:host(?:-context)?(?:\([^)]*\))?)\s*\{([^{}]*)\}/g;
const DECL_RE = /--([a-z][a-z0-9-]*)\s*:\s*([^;]+?)\s*(?:;|$)/gi;

/**
 * @typedef {import('./dtcg.mjs').RawToken} RawToken
 */

/**
 * Parse CSS source, extract `:root { --x: …; }` declarations as tokens.
 *
 * @param {string} source
 * @param {string} originPath
 * @returns {RawToken[]}
 */
export function parseCssVars(source, originPath) {
  /** @type {RawToken[]} */
  const out = [];
  let m;
  while ((m = ROOT_BLOCK_RE.exec(source))) {
    const body = m[1];
    let dm;
    while ((dm = DECL_RE.exec(body))) {
      const cssName = dm[1];
      const value = dm[2].trim();
      const name = cssName.replace(/-/g, '.');
      out.push({
        name,
        value,
        type: inferType(value),
        tier: tierFromName(name),
        originPath,
        originType: 'css-vars',
      });
    }
    DECL_RE.lastIndex = 0;
  }
  ROOT_BLOCK_RE.lastIndex = 0;
  return out;
}

function inferType(value) {
  if (parseColor(value)) return 'color';
  if (parseDimension(value)) return 'dimension';
  if (/^\d+(\.\d+)?\s*(ms|s)$/i.test(value)) return 'duration';
  return 'other';
}

function tierFromName(name) {
  const lower = name.toLowerCase();
  if (/(\.|^)(primitive|ref|reference|base|palette)\./.test('.' + lower)) return 'primitive';
  return name.split('.').length >= 3 ? 'component' : 'semantic';
}
