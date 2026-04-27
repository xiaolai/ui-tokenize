// Regex-based violation scanner.
// v0.1: regex-only (per D-027). AST scanners deferred to v0.2.

import { extname } from 'node:path';
import { parseColor } from './color.mjs';
import { parseDimension } from './dimension.mjs';

/**
 * @typedef {object} Violation
 * @property {string} literal               - the literal as found
 * @property {string} type                  - "color" | "dimension" | "tailwind-arbitrary" | "svg-attr"
 * @property {string} surface               - file-context tag
 * @property {number} line                  - 1-based
 * @property {number} column                - 1-based
 * @property {string} [contextHint]         - surrounding text for additional context
 */

const HEX_RE = /(#[0-9a-fA-F]{3,8})\b/g;
const FUNC_COLOR_RE = /\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\s*\(\s*[^)]+\)/g;
// Note: `%` is intentionally excluded from the unit list. Percentage values are
// almost always layout-intent (50%, 100%) rather than tokenizable design constants,
// and including them produces high false-positive noise. `parseDimension` accepts
// `%` for token *values* and arbitrary brackets, but the scanner does not surface
// bare `42%` as a violation. Revisit in v0.2 if a percentage-token use case lands.
const DIMENSION_RE = /(?<![\w-])(-?\d+(?:\.\d+)?)(px|rem|em|ch|vw|vh|svh|dvh|lvh)\b/g;
const TAILWIND_ARBITRARY_RE = /\b[a-z-]+-\[[^\]]+\]/g;
const SVG_COLOR_ATTR_RE = /\b(fill|stroke|stop-color)\s*=\s*["']([^"']+)["']/g;

// Find a CSS-variable / SCSS-var / LESS-var / DTCG `$value` declaration. We use this to
// strip the *declaration span only* (not the whole line) so mixed lines like
// `:root { --x: #fff; } .y { color: #abc; }` still surface the second violation.
const TOKEN_DEF_SPAN_RE = /((?:--|\$|@)[a-zA-Z0-9_-]+\s*:\s*[^;]+;?)|(\$value\s*:\s*"[^"]*")/g;

// Valid SVG paint sentinels that should NOT be flagged as hardcoded color attrs.
const SVG_COLOR_SENTINELS = new Set([
  'currentcolor', 'none', 'inherit', 'transparent', 'initial', 'unset', 'revert',
  'context-fill', 'context-stroke',
]);

/**
 * Classify a file path into a surface.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
export function classifySurface(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.css' || ext === '.pcss') return 'css';
  if (ext === '.scss') return 'scss';
  if (ext === '.less') return 'less';
  if (ext === '.tsx' || ext === '.jsx') return 'tsx';
  if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'ts';
  if (ext === '.vue') return 'vue';
  if (ext === '.svelte') return 'svelte';
  if (ext === '.astro') return 'astro';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.svg') return 'svg';
  return null;
}

/**
 * Should this file path be exempt from scanning entirely?
 * (Token-source files, dotfiles in .tokenize, etc.)
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isExemptFile(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.includes('/.tokenize/')) return true;
  if (/(^|\/)tokens\.(json|css|ts|js|mjs)$/.test(lower)) return true;
  if (/(^|\/)design-tokens\.json$/.test(lower)) return true;
  if (/(^|\/)tokens\.proposed\.json$/.test(lower)) return true;
  if (lower.endsWith('.proposed.json')) return true;
  return false;
}

/**
 * Scan source content; emit violations.
 *
 * @param {string} content
 * @param {string} filePath
 * @param {{tailwindDetected?: boolean}} [opts]
 * @returns {Violation[]}
 */
export function scan(content, filePath, opts = {}) {
  if (isExemptFile(filePath)) return [];
  const surface = classifySurface(filePath);
  if (!surface) return [];

  /** @type {Violation[]} */
  const violations = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    // Strip token-definition spans only (not the whole line) so mixed lines still scan.
    const line = stripTokenDefSpans(original);
    pushMatches(line, HEX_RE, 'color', surface, i + 1, violations);
    pushMatches(line, FUNC_COLOR_RE, 'color', surface, i + 1, violations);
    if (surface !== 'ts') {
      // bare `16px` is a dimension violation in CSS/JSX/Vue/Svelte/Astro/HTML.
      pushMatches(line, DIMENSION_RE, 'dimension', surface, i + 1, violations);
    } else {
      // In .ts/.js, only flag dimensions inside template literals likely to be CSS.
      if (/(?:styled\.|css`|keyframes`|injectGlobal)/.test(content)) {
        pushMatches(line, DIMENSION_RE, 'dimension', surface, i + 1, violations);
      }
    }
    if (opts.tailwindDetected && (surface === 'tsx' || surface === 'html' || surface === 'vue' || surface === 'svelte' || surface === 'astro')) {
      pushTailwindArbitrary(line, i + 1, violations);
    }
    if (surface === 'svg' || surface === 'tsx' || surface === 'html') {
      let m;
      while ((m = SVG_COLOR_ATTR_RE.exec(line))) {
        const attrValue = m[2];
        if (!isSvgColorSentinel(attrValue)) {
          violations.push({
            literal: attrValue,
            type: 'color',
            surface: 'svg-attr',
            line: i + 1,
            column: m.index + m[0].indexOf(attrValue) + 1,
            contextHint: m[0],
          });
        }
      }
      SVG_COLOR_ATTR_RE.lastIndex = 0;
    }
  }
  return violations;
}

/**
 * Strip token-definition spans from a line, replacing them with spaces (preserving
 * column positions of unaffected tokens later in the line).
 */
function stripTokenDefSpans(line) {
  let out = line;
  let m;
  TOKEN_DEF_SPAN_RE.lastIndex = 0;
  while ((m = TOKEN_DEF_SPAN_RE.exec(out))) {
    const span = m[0];
    out = out.slice(0, m.index) + ' '.repeat(span.length) + out.slice(m.index + span.length);
    TOKEN_DEF_SPAN_RE.lastIndex = m.index + span.length;
  }
  TOKEN_DEF_SPAN_RE.lastIndex = 0;
  return out;
}

function isSvgColorSentinel(value) {
  const v = value.trim().toLowerCase();
  if (SVG_COLOR_SENTINELS.has(v)) return true;
  if (v.startsWith('url(')) return true;
  if (v.startsWith('var(--')) return true;
  return false;
}

/**
 * Push tailwind-arbitrary violations with type already inferred from the bracket payload.
 * Sets surface='tailwind-arbitrary' so the renderer can preserve the utility prefix.
 *
 * @param {string} line
 * @param {number} lineNum
 * @param {Violation[]} out
 */
function pushTailwindArbitrary(line, lineNum, out) {
  let m;
  while ((m = TAILWIND_ARBITRARY_RE.exec(line))) {
    const literal = m[0];
    const inner = /\[([^\]]+)\]/.exec(literal);
    if (!inner) continue;
    const payload = inner[1];
    const inferredType = parseColor(payload) ? 'color' : parseDimension(payload) ? 'dimension' : null;
    if (!inferredType) continue;
    out.push({
      literal,
      type: inferredType,
      surface: 'tailwind-arbitrary',
      line: lineNum,
      column: m.index + 1,
      contextHint: line.slice(Math.max(0, m.index - 10), Math.min(line.length, m.index + literal.length + 20)),
    });
  }
  TAILWIND_ARBITRARY_RE.lastIndex = 0;
}

/**
 * @param {string} line
 * @param {RegExp} re
 * @param {string} type
 * @param {string} surface
 * @param {number} lineNum
 * @param {Violation[]} out
 */
function pushMatches(line, re, type, surface, lineNum, out) {
  let m;
  while ((m = re.exec(line))) {
    out.push({
      literal: m[0],
      type,
      surface,
      line: lineNum,
      column: m.index + 1,
      contextHint: line.slice(Math.max(0, m.index - 10), Math.min(line.length, m.index + m[0].length + 20)),
    });
  }
  re.lastIndex = 0;
}
