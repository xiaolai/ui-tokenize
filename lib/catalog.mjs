// Catalog: discover, merge, persist, query.
// Per-category precedence (D-021); conflicts logged not silenced.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { canonicalColor, parseColor } from './color.mjs';
import { canonicalDimension, parseDimension } from './dimension.mjs';
import { parseDtcg } from './discover/dtcg.mjs';
import { parseCssVars } from './discover/css-vars.mjs';
import { tokenizeDir } from './paths.mjs';
import { precedenceFor, readConfig } from './config.mjs';
import { loadIgnore } from './ignore.mjs';

/**
 * @typedef {import('./discover/dtcg.mjs').RawToken} Token
 *
 * @typedef {object} ValueIndexEntry
 * @property {string} value           - canonical value (e.g. "#b91c1c")
 * @property {any} normalized         - numeric form for nearest-neighbor (rgb / px / etc.)
 * @property {string[]} tokenNames
 *
 * @typedef {object} Conflict
 * @property {string} tokenName
 * @property {Array<{source: string, value: string}>} definitions
 * @property {string} resolution     - originType chosen
 *
 * @typedef {object} Catalog
 * @property {string} generatedAt
 * @property {string} root
 * @property {Array<{type: string, path: string, tokenCount: number}>} sources
 * @property {Object<string, Token>} tokens
 * @property {Object<string, ValueIndexEntry[]>} valueIndex
 * @property {Conflict[]} conflicts
 */

const TOKEN_FILE_NAMES = new Set(['tokens.json', 'design-tokens.json']);
const CSS_EXTS = new Set(['.css', '.scss', '.less', '.pcss']);

/**
 * Discover all token sources under `root`, merge with per-category precedence,
 * and produce a canonical Catalog.
 *
 * @param {string} root - absolute path of token-root directory
 * @returns {Catalog}
 */
export function discoverCatalog(root) {
  const config = readConfig(root);
  const ignore = loadIgnore(root, config.ignore);
  /** @type {Token[]} */
  const all = [];
  /** @type {Catalog['sources']} */
  const sources = [];

  for (const file of walkSources(root, ignore)) {
    const before = all.length;
    try {
      readSource(file, all);
    } catch (err) {
      process.stderr.write(`[ui-tokenize] WARN: failed to parse ${file}: ${err.message}\n`);
      continue;
    }
    if (all.length > before) {
      const last = all[all.length - 1];
      sources.push({ type: last.originType, path: relative(root, file), tokenCount: all.length - before });
    }
  }

  const { tokens, conflicts } = mergeWithPrecedence(all, config);
  const valueIndex = buildValueIndex(tokens);
  return {
    generatedAt: new Date().toISOString(),
    root,
    sources,
    tokens,
    valueIndex,
    conflicts,
  };
}

/**
 * Persist a catalog to `.tokenize/catalog.json` and `.tokenize/conflicts.json`.
 *
 * @param {Catalog} catalog
 */
export function writeCatalog(catalog) {
  const dir = tokenizeDir(catalog.root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog, null, 2));
  if (catalog.conflicts.length > 0) {
    writeFileSync(join(dir, 'conflicts.json'), JSON.stringify({ conflicts: catalog.conflicts }, null, 2));
  }
}

/**
 * Read a previously written catalog, or null if missing/malformed.
 *
 * @param {string} root
 * @returns {Catalog|null}
 */
export function readCatalog(root) {
  const path = join(tokenizeDir(root), 'catalog.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check whether `absPath` is a token-source file according to the catalog.
 * Includes both the canonical DTCG filenames and any CSS / SCSS / LESS / TS
 * file that contributed tokens during discovery.
 *
 * @param {string} absPath
 * @param {Catalog | null | undefined} catalog
 * @returns {boolean}
 */
export function isCatalogTokenSource(absPath, catalog) {
  const norm = absPath.replace(/\\/g, '/');
  if (/(^|\/)(tokens|design-tokens)\.json$/.test(norm)) return true;
  if (!catalog?.sources) return false;
  for (const s of catalog.sources) {
    const sourceAbs = (s.path.startsWith('/') ? s.path : join(catalog.root, s.path)).replace(/\\/g, '/');
    if (sourceAbs === norm) return true;
  }
  return false;
}

// --------------------------------------------------------------------------------
// Source discovery
// --------------------------------------------------------------------------------

function* walkSources(root, ignore) {
  yield* walk(root, root, ignore);
}

function* walk(dir, root, ignore) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (ignore && ignore.isIgnored(full)) continue;
    if (e.isDirectory()) {
      // Skip nested package roots so monorepo packages get their own catalogs.
      if (existsSync(join(full, 'package.json')) && full !== root) continue;
      yield* walk(full, root, ignore);
    } else if (e.isFile()) {
      if (TOKEN_FILE_NAMES.has(e.name) || CSS_EXTS.has(extname(e.name))) {
        yield full;
      }
    }
  }
}

function readSource(file, out) {
  const ext = extname(file).toLowerCase();
  const base = basename(file);
  if (TOKEN_FILE_NAMES.has(base)) {
    const raw = readFileSync(file, 'utf8');
    const doc = JSON.parse(raw);
    out.push(...parseDtcg(doc, file));
  } else if (CSS_EXTS.has(ext)) {
    const raw = readFileSync(file, 'utf8');
    out.push(...parseCssVars(raw, file));
  }
}

// --------------------------------------------------------------------------------
// Merge with per-category precedence
// --------------------------------------------------------------------------------

/**
 * @param {Token[]} all
 * @param {import('./config.mjs').TokenizeConfig} config
 */
function mergeWithPrecedence(all, config) {
  /** @type {Map<string, Token[]>} */
  const byName = new Map();
  for (const t of all) {
    if (!byName.has(t.name)) byName.set(t.name, []);
    byName.get(t.name).push(t);
  }
  /** @type {Object<string, Token>} */
  const tokens = {};
  /** @type {Conflict[]} */
  const conflicts = [];
  for (const [name, defs] of byName) {
    if (defs.length === 1) {
      tokens[name] = defs[0];
      continue;
    }
    const prec = precedenceFor(config, defs[0].type);
    const sorted = [...defs].sort((a, b) => orderIn(prec, a.originType) - orderIn(prec, b.originType));
    const winner = sorted[0];
    tokens[name] = winner;
    // Only count as conflict if values differ.
    const valueSet = new Set(defs.map((d) => d.value));
    if (valueSet.size > 1) {
      conflicts.push({
        tokenName: name,
        definitions: defs.map((d) => ({ source: `${d.originType}:${d.originPath}`, value: d.value })),
        resolution: winner.originType,
      });
    }
  }
  return { tokens, conflicts };
}

function orderIn(precedence, type) {
  const i = precedence.indexOf(type);
  return i === -1 ? 999 : i;
}

// --------------------------------------------------------------------------------
// Value index for fast nearest-neighbor lookup
// --------------------------------------------------------------------------------

function buildValueIndex(tokens) {
  /** @type {Object<string, ValueIndexEntry[]>} */
  const idx = {};
  for (const t of Object.values(tokens)) {
    if (t.tier === 'primitive') continue;     // primitives sealed from suggestion
    if (t.deprecated) continue;
    let entry;
    if (t.type === 'color') {
      const rgb = parseColor(t.value);
      if (!rgb) continue;
      entry = { value: canonicalColor(t.value), normalized: rgb, tokenNames: [t.name] };
    } else if (t.type === 'dimension') {
      const d = parseDimension(t.value);
      if (!d) continue;
      entry = { value: canonicalDimension(t.value), normalized: d, tokenNames: [t.name] };
    } else {
      entry = { value: t.value, normalized: t.value, tokenNames: [t.name] };
    }
    if (!idx[t.type]) idx[t.type] = [];
    // Merge tokens with identical canonical value.
    const existing = idx[t.type].find((e) => e.value === entry.value);
    if (existing) existing.tokenNames.push(t.name);
    else idx[t.type].push(entry);
  }
  return idx;
}
