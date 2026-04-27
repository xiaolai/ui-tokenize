// Surface-aware token rendering.
// Default conventions per surface; overridden by an observed consumerProfile when available.

/**
 * @typedef {import('./consumer-profile.mjs').ConsumerProfile} ConsumerProfile
 */

/**
 * Render a token reference in the syntax appropriate for the surface.
 *
 * @param {string} tokenName        - dot-path token name (e.g. "color.text.danger")
 * @param {string} surface          - surface tag from scanner
 * @param {ConsumerProfile} [profile]
 * @returns {string}
 */
export function renderToken(tokenName, surface, profile) {
  const observed = profile?.surfaces?.[surface];
  if (observed && observed.convention) {
    return applyConvention(tokenName, observed.convention);
  }
  return applyConvention(tokenName, defaultConventionFor(surface));
}

/**
 * Replace a literal in source with a token reference.
 * Returns the new source string.
 *
 * @param {string} content
 * @param {{line: number, column: number, literal: string}} location
 * @param {string} replacement
 * @returns {string}
 */
export function replaceAt(content, location, replacement) {
  const lines = content.split(/\r?\n/);
  const idx = location.line - 1;
  if (idx < 0 || idx >= lines.length) return content;
  const line = lines[idx];
  const start = location.column - 1;
  const end = start + location.literal.length;
  if (line.slice(start, end) !== location.literal) return content; // moved; refuse
  lines[idx] = line.slice(0, start) + replacement + line.slice(end);
  return lines.join('\n');
}

/**
 * Default convention per surface (used when no consumer profile is available).
 *
 * @param {string} surface
 * @returns {string}
 */
function defaultConventionFor(surface) {
  switch (surface) {
    case 'css':
    case 'pcss':
    case 'vue':
    case 'svelte':
    case 'astro':
    case 'html':
      return 'var(--{kebab})';
    case 'scss':
      return '$' + '{kebab}';                    // template "${kebab}" → after substitution: "$<kebab-name>"
    case 'less':
      return '@' + '{kebab}';                    // template "@{kebab}" → after substitution: "@<kebab-name>"
    case 'tsx':
    case 'jsx':
    case 'ts':
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'tokens.{js}';
    case 'svg-attr':
      return 'var(--{kebab})';
    case 'tailwind-arbitrary':
      return '{tailwind}';
    default:
      return 'var(--{kebab})';
  }
}

/**
 * Apply a convention template to a token name.
 * Supported placeholders: {kebab}, {js}, {dotted}, {tailwind}
 *
 * @param {string} tokenName
 * @param {string} convention
 * @returns {string}
 */
function applyConvention(tokenName, convention) {
  return convention
    .replaceAll('{kebab}', toKebab(tokenName))
    .replaceAll('{js}', toJsPath(tokenName))
    .replaceAll('{dotted}', tokenName)
    .replaceAll('{tailwind}', toTailwindUtility(tokenName));
}

function toKebab(name) {
  return name.replace(/\./g, '-');
}

function toJsPath(name) {
  // numeric segments get bracket access: "space.4" → "tokens.space[4]"
  const parts = name.split('.');
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    if (/^\d+$/.test(parts[i])) out += `[${parts[i]}]`;
    else out += `.${parts[i]}`;
  }
  return out;
}

function toTailwindUtility(name) {
  // Heuristic: "color.text.danger" → "text-danger"; "space.4" → "p-4" (caller may need to swap prefix)
  // Returns a kebab form from the *last two* segments; caller decides how to compose with utility prefix.
  const parts = name.split('.');
  const tail = parts.slice(-2).join('-');
  return tail;
}
