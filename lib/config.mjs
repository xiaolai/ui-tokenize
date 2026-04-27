// Read .tokenize/config.json (mode, precedence overrides, ignore globs).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenizeDir } from './paths.mjs';

/**
 * @typedef {object} TokenizeConfig
 * @property {"consumer"|"maintainer"} mode
 * @property {Object<string, string[]>} precedence  - per-category source precedence; "_default" key applies elsewhere
 * @property {string[]} ignore                      - additional ignore globs
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

/** @returns {TokenizeConfig} */
export function defaultConfig() {
  return {
    mode: 'consumer',
    precedence: { _default: [...DEFAULT_PRECEDENCE] },
    ignore: [],
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
    precedence: {
      ...base.precedence,
      ...(override.precedence ?? {}),
    },
    ignore: Array.isArray(override.ignore) ? override.ignore : base.ignore,
    disabled: !!override.disabled,
  };
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
