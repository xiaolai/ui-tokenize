// Centralized ignore-glob matcher (D-017). Loads .gitignore + .tokenize/ignore +
// hardcoded defaults; compiles once; exposes a single `isIgnored(absPath)` predicate.
//
// Glob support is deliberately minimal — covers the common .gitignore vocabulary:
//   *           any chars except /
//   **          any chars including /
//   ?           single char
//   /pattern    rooted at the matcher base
//   pattern/    matches a directory (matches both the dir and any path under it)
//   !pattern    negation (un-ignore something previously ignored)
//   #comment    line comment

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const HARD_DEFAULTS = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  '.next/',
  '.turbo/',
  'coverage/',
  '.tokenize/',
  '*.lock',
  '.DS_Store',
];

/**
 * @typedef {object} CompiledRule
 * @property {RegExp} re
 * @property {boolean} negate
 * @property {boolean} dirOnly
 *
 * @typedef {object} IgnoreMatcher
 * @property {string} base
 * @property {(absPath: string) => boolean} isIgnored
 */

/**
 * Build an IgnoreMatcher rooted at `base`. Reads `.gitignore` and `.tokenize/ignore`
 * if present; appends `extra` patterns; always applies HARD_DEFAULTS.
 *
 * @param {string} base
 * @param {string[]} [extra]
 * @returns {IgnoreMatcher}
 */
export function loadIgnore(base, extra = []) {
  const lines = [...HARD_DEFAULTS];
  for (const file of [join(base, '.gitignore'), join(base, '.tokenize', 'ignore')]) {
    if (existsSync(file)) {
      try {
        for (const ln of readFileSync(file, 'utf8').split(/\r?\n/)) {
          if (!ln.trim() || ln.trim().startsWith('#')) continue;
          lines.push(ln.trim());
        }
      } catch { /* ignore */ }
    }
  }
  for (const e of extra) lines.push(e);
  const rules = lines.map(compileRule);
  return {
    base,
    isIgnored(absPath) {
      const rel = toRel(base, absPath);
      if (rel == null) return false;
      let ignored = false;
      for (const r of rules) {
        if (r.re.test(rel) || r.re.test(rel + '/')) {
          ignored = !r.negate;
        }
      }
      return ignored;
    },
  };
}

function toRel(base, absPath) {
  const r = relative(base, absPath);
  if (r.startsWith('..')) return null;
  return r.split(sep).join('/');
}

function compileRule(pattern) {
  let p = pattern;
  let negate = false;
  if (p.startsWith('!')) { negate = true; p = p.slice(1); }
  let rooted = false;
  if (p.startsWith('/')) { rooted = true; p = p.slice(1); }
  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }
  const re = new RegExp(globToRegExpStr(p, rooted, dirOnly));
  return { re, negate, dirOnly };
}

/**
 * Convert a single glob pattern to a regex source string.
 * Exposed for callers that need to compile a single user-supplied glob (e.g.
 * the audit `--suppressions` file) without building a full IgnoreMatcher.
 *
 * @param {string} p
 * @param {boolean} [rooted]
 * @param {boolean} [dirOnly]
 * @returns {string}
 */
export function globToRegExpStr(p, rooted = false, dirOnly = false) {
  const STAR_STAR = '\x00';      // sentinel for "**" during transformation
  let r = p.replace(/[.+^${}()|\\]/g, '\\$&');
  r = r.replace(/\*\*/g, STAR_STAR);
  r = r.replace(/\*/g, '[^/]*');
  r = r.replace(/\?/g, '[^/]');
  r = r.replaceAll(STAR_STAR, '.*');
  const prefix = rooted ? '^' : '^(?:.*/)?';
  const suffix = dirOnly ? '(?:/.*)?$' : '(?:/.*)?$';
  return prefix + r + suffix;
}
