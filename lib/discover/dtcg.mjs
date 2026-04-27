// W3C DTCG Format Module 2025.10 parser.
// Walks the JSON tree, emits Token records, resolves aliases.

/**
 * @typedef {object} RawToken
 * @property {string} name
 * @property {string} value
 * @property {string} type
 * @property {string} tier
 * @property {string} originPath
 * @property {string} originType
 * @property {string} [description]
 * @property {boolean} [deprecated]
 */

const PRIMITIVE_GROUP_NAMES = new Set(['primitive', 'ref', 'reference', 'base', 'palette']);
const ALIAS_RE = /^\{([^{}]+)\}$/;

const TYPE_INFERENCE = [
  { type: 'color', test: (v) => /^(#|rgb|hsl|oklch|oklab|lab|lch|color\()/i.test(String(v)) },
  { type: 'dimension', test: (v) => /^-?\d+(\.\d+)?\s*(px|rem|em|ch|vw|vh|svh|dvh|lvh|%)$/i.test(String(v)) },
  { type: 'duration', test: (v) => /^\d+(\.\d+)?\s*(ms|s)$/i.test(String(v)) },
  { type: 'shadow', test: (v) => /^[\d.]+px\s+[\d.]+px/.test(String(v)) },
];

/**
 * Parse a DTCG JSON document into raw tokens.
 *
 * @param {unknown} doc - parsed JSON
 * @param {string} originPath - source file path
 * @returns {RawToken[]}
 */
export function parseDtcg(doc, originPath) {
  if (!doc || typeof doc !== 'object') return [];
  /** @type {RawToken[]} */
  const out = [];
  walk(/** @type {object} */ (doc), [], out, originPath);
  // Resolve one level of aliases pointing to other tokens in the same doc.
  const byName = new Map(out.map((t) => [t.name, t]));
  for (const t of out) {
    const m = ALIAS_RE.exec(t.value);
    if (m) {
      const target = byName.get(m[1]);
      if (target) {
        t.value = target.value;
        if (!t.type || t.type === 'other') t.type = target.type;
      }
    }
  }
  return out;
}

/**
 * @param {object} node
 * @param {string[]} path
 * @param {RawToken[]} out
 * @param {string} originPath
 */
function walk(node, path, out, originPath) {
  if (Array.isArray(node)) return;
  // A DTCG token node has $value (and usually $type).
  if ('$value' in node) {
    const value = String(node.$value ?? '');
    const declaredType = typeof node.$type === 'string' ? node.$type : null;
    const type = declaredType || inferType(value);
    /** @type {RawToken} */
    const tok = {
      name: path.join('.'),
      value,
      type,
      tier: tierFromPath(path),
      originPath,
      originType: 'dtcg-json',
    };
    if (typeof node.$description === 'string') tok.description = node.$description;
    if (node.$deprecated) tok.deprecated = true;
    out.push(tok);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith('$')) continue;
    const child = /** @type {any} */ (node)[key];
    if (child && typeof child === 'object') {
      walk(child, [...path, key], out, originPath);
    }
  }
}

function inferType(value) {
  for (const rule of TYPE_INFERENCE) if (rule.test(value)) return rule.type;
  return 'other';
}

/**
 * Heuristic tier from path segments. A token is "primitive" only when one of its
 * ancestor groups (NOT the leaf name itself) is a primitive marker — so
 * `font-size.base` is semantic even though "base" appears in the marker set.
 *
 * @param {string[]} path
 */
function tierFromPath(path) {
  // Check ancestors only (everything except the leaf segment).
  for (let i = 0; i < path.length - 1; i++) {
    if (PRIMITIVE_GROUP_NAMES.has(path[i].toLowerCase())) return 'primitive';
  }
  return path.length >= 3 ? 'component' : 'semantic';
}
