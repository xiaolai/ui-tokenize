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

// HEX_RE — match a hex literal in *value* position. Two negative lookbehinds:
//
//   (?<![\w\-.]) — rejects matches preceded by an identifier character, dash,
//   or dot. That excludes:
//     - URL fragments like `https://example.com#abc` (preceded by `m`)
//     - URL fragments like `/path-name#abc` (preceded by `-`)
//     - JS private-field access like `this.#abc` (preceded by `.`)
//     - GitHub permalinks like `pull/298#discussion_r12345` (preceded by `8`)
//
//   (?<!\{\s*) — rejects matches preceded by an open brace plus optional
//   whitespace. That excludes:
//     - JS/TS class private-field declarations like `class X { #abc = 1; }`
//       (the `#abc` sits at body-start, preceded by `{` then whitespace).
//     - SCSS/LESS nested-id-selector openings like `.foo { #abc { ... } }`
//       (also a selector position, not a value).
//   Variable-width `\s*` matches zero or more whitespace chars including
//   newlines. CSS values like `color: #abc` are unaffected because the path
//   from any preceding `{` to `#` includes non-whitespace chars (`color:`).
//
// Both conditions together still match the legitimate cases:
//   - `color: #abc` (space before, after `:` or whitespace)
//   - `color:#abc` (preceded by `:`)
//   - `bg-[#abc]` (preceded by `[`)
//   - `style={{ color: '#abc' }}` (preceded by `'`)
const HEX_RE = /(?<![\w\-.])(?<!\{\s*)(#[0-9a-fA-F]{3,8})\b/g;
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

// JS/TS comment-or-protected pattern. Alternation order matters — strings and
// template literals are matched FIRST so a `//` or `/*` that appears inside a
// string is consumed as part of the string match and never reaches the comment
// alternations. Result: `const x = "// not a comment";` keeps its string intact.
//
// Known limitations:
//   - regex literals are not detected; a `//` inside a regex like `/\/\//`
//     can be mis-stripped (low impact: regex-literal-content is rarely a
//     CSS context, so we'd lose at most a non-violation, never gain one).
//   - `${expr}` interpolations inside template literals are treated as
//     template content; comments inside `${ /* ... */ }` are not stripped.
//   - nested template literals are not modeled correctly.
const JS_PROTECTED_OR_COMMENT_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const CSS_BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const SCSS_LINE_COMMENT_RE = /\/\/[^\n]*/g;

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
 * @param {{tailwindDetected?: boolean, allowedSurfaces?: string[]|null}} [opts]
 *   allowedSurfaces — null/undefined means scan every recognized surface; an
 *   array narrows scanning to just those surface tags (see KNOWN_SURFACES in
 *   lib/config.mjs). Used by `surfaces` in `.tokenize/config.json`.
 * @returns {Violation[]}
 */
export function scan(content, filePath, opts = {}) {
  if (isExemptFile(filePath)) return [];
  const surface = classifySurface(filePath);
  if (!surface) return [];
  if (opts.allowedSurfaces && !opts.allowedSurfaces.includes(surface)) return [];

  // Pre-pass: strip comments at content level so multi-line block comments
  // and JSDoc don't leak hex-like patterns into the per-line scan. Replaces
  // comment characters with spaces, preserving newlines and column positions.
  const decommented = stripCommentsForSurface(content, surface);

  /** @type {Violation[]} */
  const violations = [];
  const lines = decommented.split(/\r?\n/);

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
 * Strip comments per surface so hex-like patterns inside comment bodies
 * do not false-positive. Comment characters are replaced with spaces;
 * newlines are preserved so line/column reporting stays accurate.
 *
 * Strings and template literals are kept intact for JS surfaces: the agent
 * may legitimately put hex inside a string (inline-style attributes, JSX
 * style props, etc.) and we still want to flag those.
 *
 * @param {string} content
 * @param {string} surface
 * @returns {string}
 */
function stripCommentsForSurface(content, surface) {
  if (!surface) return content;
  let out = content;

  // HTML-style comments first — for HTML, SVG, and frameworks with template
  // sections (Vue, Svelte, Astro). Done before JS-comment stripping so an
  // HTML comment containing `//` does not get partially mangled.
  if (surface === 'html' || surface === 'svg' || surface === 'vue' || surface === 'svelte' || surface === 'astro') {
    out = out.replace(HTML_COMMENT_RE, replaceWithSpacesPreserveNewlines);
  }

  // JS-style comments with string/template protection — for JS/TS/JSX/TSX
  // surfaces, plus the script-bearing parts of Vue/Svelte/Astro.
  if (surface === 'ts' || surface === 'tsx' || surface === 'vue' || surface === 'svelte' || surface === 'astro') {
    out = out.replace(JS_PROTECTED_OR_COMMENT_RE, (match) => {
      if (match.startsWith('//') || match.startsWith('/*')) {
        return replaceWithSpacesPreserveNewlines(match);
      }
      return match;
    });
  }

  // CSS-style comments — only for pure CSS-family files. We deliberately do
  // NOT run these globally on Vue/Svelte/Astro/HTML because `<script>` blocks
  // can contain `/* ... */` inside string literals (which the JS pass above
  // already protected); a second naive pass would damage them.
  if (surface === 'css' || surface === 'scss' || surface === 'less') {
    out = out.replace(CSS_BLOCK_COMMENT_RE, replaceWithSpacesPreserveNewlines);
    if (surface === 'scss' || surface === 'less') {
      out = out.replace(SCSS_LINE_COMMENT_RE, replaceWithSpacesPreserveNewlines);
    }
  }

  return out;
}

function replaceWithSpacesPreserveNewlines(s) {
  return s.replace(/[^\r\n]/g, ' ');
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
