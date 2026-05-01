// Read .tokenize/config.json (mode, precedence overrides, ignore globs).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenizeDir } from './paths.mjs';

/**
 * @typedef {object} TokenizeConfig
 * @property {"consumer"|"maintainer"} mode
 * @property {"strict"|"advisory"} strictness       - PreToolUse policy on uncertain literals: "strict" denies and asks for retry, "advisory" passes through and lets PostToolUse surface findings as additionalContext. Exact-match rewrites and structural denies (token-source edits, missing catalog) are unaffected.
 * @property {Object<string, string[]>} precedence  - per-category source precedence; "_default" key applies elsewhere
 * @property {string[]} ignore                      - additional ignore globs
 * @property {string[]|null} surfaces               - allowlist of file surfaces to scan; null means all (default). Recognized: css, scss, less, tsx, ts, vue, svelte, astro, html, svg.
 * @property {boolean} disabled                     - global kill switch
 */

const DEFAULT_PRECEDENCE = [
  'dtcg-json',
  'css-vars',
  'scss-vars',
  'less-vars',
  'ts-export',
  'tailwind',
  'css-in-js',
];

/**
 * Canonical list of surface tags emitted by lib/scanner.mjs::classifySurface.
 * Update both lists together if a new file surface is added.
 */
export const KNOWN_SURFACES = Object.freeze([
  'css', 'scss', 'less', 'tsx', 'ts', 'vue', 'svelte', 'astro', 'html', 'svg',
]);

/** @returns {TokenizeConfig} */
export function defaultConfig() {
  return {
    mode: 'consumer',
    strictness: 'strict',
    precedence: { _default: [...DEFAULT_PRECEDENCE] },
    ignore: [],
    surfaces: null,
    disabled: false,
  };
}

/**
 * Read the config for the project containing `workingFile`.
 * Missing file → defaults. Malformed file → defaults + warning to stderr.
 *
 * @param {string} workingFile
 * @returns {TokenizeConfig}
 */
export function readConfig(workingFile) {
  const path = join(tokenizeDir(workingFile), 'config.json');
  if (!existsSync(path)) return defaultConfig();
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return mergeConfig(defaultConfig(), parsed);
  } catch (err) {
    process.stderr.write(`[ui-tokenize] WARN: malformed ${path}: ${err.message}\n`);
    return defaultConfig();
  }
}

/**
 * @param {TokenizeConfig} base
 * @param {Partial<TokenizeConfig>} override
 * @returns {TokenizeConfig}
 */
function mergeConfig(base, override) {
  return {
    mode: override.mode === 'maintainer' ? 'maintainer' : 'consumer',
    strictness: override.strictness === 'advisory' ? 'advisory' : 'strict',
    precedence: {
      ...base.precedence,
      ...(override.precedence ?? {}),
    },
    ignore: Array.isArray(override.ignore) ? override.ignore : base.ignore,
    surfaces: normalizeSurfaces(override.surfaces, base.surfaces),
    disabled: !!override.disabled,
  };
}

/**
 * Validate the user-supplied surfaces allowlist against KNOWN_SURFACES.
 *
 *   null / undefined / non-array → fallback (current behavior: scan all)
 *   array of strings             → keep recognized, drop+warn unknown
 *   empty array (after filter)   → kept as []  (= scan nothing; warn)
 *
 * @param {unknown} override
 * @param {string[]|null} fallback
 * @returns {string[]|null}
 */
function normalizeSurfaces(override, fallback) {
  if (override === null) return null;
  if (!Array.isArray(override)) return fallback;
  const known = new Set(KNOWN_SURFACES);
  const accepted = [];
  const rejected = [];
  for (const s of override) {
    if (typeof s !== 'string') { rejected.push(String(s)); continue; }
    const norm = s.toLowerCase();
    if (known.has(norm)) accepted.push(norm);
    else rejected.push(s);
  }
  if (rejected.length > 0) {
    process.stderr.write(
      `[ui-tokenize] WARN: ignoring unknown surface(s) in config: ${rejected.join(', ')}. Known: ${KNOWN_SURFACES.join(', ')}.\n`,
    );
  }
  if (accepted.length === 0 && override.length > 0) {
    // User specified surfaces but every entry was unknown — refuse to silently
    // disable scanning. Fall back to default.
    process.stderr.write(
      `[ui-tokenize] WARN: surfaces config had no recognized entries; falling back to default (scan all).\n`,
    );
    return fallback;
  }
  if (accepted.length === 0) {
    // Explicit empty array — user opted to scan nothing. Allow it but tell them
    // disabled:true is the cleaner switch.
    process.stderr.write(
      `[ui-tokenize] WARN: surfaces config is an empty list; nothing will be scanned. Use "disabled": true if that's the intent.\n`,
    );
  }
  return accepted;
}

/**
 * Should this surface be scanned under the given config?
 *
 * @param {string|null} surface
 * @param {TokenizeConfig} config
 * @returns {boolean}
 */
export function isSurfaceAllowed(surface, config) {
  if (!surface) return false;
  if (config.surfaces === null) return true;
  return config.surfaces.includes(surface);
}

/**
 * Resolve the source-precedence list for a token category.
 *
 * @param {TokenizeConfig} config
 * @param {string} category
 * @returns {string[]}
 */
export function precedenceFor(config, category) {
  return config.precedence[category] ?? config.precedence._default ?? DEFAULT_PRECEDENCE;
}
